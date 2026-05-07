import { useState, useRef, useCallback } from "react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface ProcessResult {
  html: string;
  downloaded: number;
  failed: number;
  failedUrls: string[];
}

interface HtmlImageProcessorOptions {
  getCampaignId: () => string | null;
  getSessionId?: () => string | null;
  setSessionId?: (id: string) => void;
}

let requestCounter = 0;

function formatFailedUrl(raw: string): string {
  try {
    return new URL(raw).pathname.split("/").pop() || raw;
  } catch {
    return raw.length > 40 ? raw.slice(0, 37) + "..." : raw;
  }
}

export function useHtmlImageProcessor(options: HtmlImageProcessorOptions) {
  const [processing, setProcessing] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const activeRequestRef = useRef<number>(0);
  const { toast } = useToast();

  const cancel = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  }, []);

  const processHtmlImages = useCallback(
    async (html: string, mtaId?: string): Promise<string> => {
      let targetId = options.getCampaignId();

      if (!targetId && options.getSessionId && options.setSessionId) {
        let sessionId = options.getSessionId();
        if (!sessionId) {
          const sessionRes = await apiRequest("POST", "/api/campaign-assets/session");
          if (!sessionRes.ok) throw new Error("Failed to create asset session");
          const sessionData = await sessionRes.json();
          sessionId = sessionData.sessionId;
          options.setSessionId(sessionId!);
        }
        targetId = sessionId;
      }

      if (!targetId) return html;

      cancel();
      const controller = new AbortController();
      abortRef.current = controller;
      const requestId = ++requestCounter;
      activeRequestRef.current = requestId;

      try {
        setProcessing(true);
        const res = await apiRequest(
          "POST",
          `/api/campaigns/${targetId}/process-html`,
          { html, ...(mtaId ? { mtaId } : {}) },
          controller.signal,
        );

        const data: ProcessResult = await res.json();

        if (data.downloaded > 0 || data.failed > 0) {
          const parts: string[] = [];
          if (data.downloaded > 0) parts.push(`${data.downloaded} image(s) downloaded`);
          if (data.failed > 0) parts.push(`${data.failed} failed`);

          const failedSummary = data.failedUrls?.length
            ? `. Failed: ${data.failedUrls.slice(0, 3).map(formatFailedUrl).join(", ")}${data.failedUrls.length > 3 ? ` +${data.failedUrls.length - 3} more` : ""}`
            : "";

          toast({
            title: data.failed > 0 ? "Images partially processed" : "Images processed",
            description: parts.join(", ") + failedSummary,
            variant: data.failed > 0 ? "destructive" : "default",
          });
        }

        return data.html;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          if (activeRequestRef.current === requestId) {
            toast({
              title: "Processing cancelled",
              description: "Image processing was cancelled. Using original HTML.",
            });
          }
          return html;
        }
        console.error("Error processing HTML images:", error);
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        toast({
          title: "Image processing failed",
          description: `Could not process images: ${errorMessage}. Using original HTML.`,
          variant: "destructive",
        });
        return html;
      } finally {
        if (activeRequestRef.current === requestId) {
          setProcessing(false);
          abortRef.current = null;
        }
      }
    },
    [options, cancel, toast],
  );

  return { processing, processHtmlImages, cancel };
}
