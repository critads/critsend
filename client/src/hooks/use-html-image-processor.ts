import { useState, useRef, useCallback } from "react";
import { apiRequest, fetchCsrfToken } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface ProcessResult {
  html: string;
  downloaded: number;
  failed: number;
  failedUrls: string[];
}

export interface ImageProgress {
  processed: number;
  total: number;
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

function parseSSEEvents(chunk: string): Array<{ event: string; data: string }> {
  const events: Array<{ event: string; data: string }> = [];
  const blocks = chunk.split("\n\n");
  for (const block of blocks) {
    if (!block.trim()) continue;
    let event = "";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7);
      else if (line.startsWith("data: ")) data = line.slice(6);
    }
    if (event && data) events.push({ event, data });
  }
  return events;
}

export function useHtmlImageProcessor(options: HtmlImageProcessorOptions) {
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState<ImageProgress | null>(null);
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
        setProgress(null);

        const csrfToken = await fetchCsrfToken();
        const res = await fetch(`/api/campaigns/${targetId}/process-html`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            "x-csrf-token": csrfToken,
          },
          body: JSON.stringify({ html, ...(mtaId ? { mtaId } : {}) }),
          credentials: "include",
          signal: controller.signal,
        });

        if (!res.ok) {
          const text = await res.text();
          throw new Error(`${res.status}: ${text}`);
        }

        let result: ProcessResult | null = null;
        const reader = res.body?.getReader();
        if (!reader) throw new Error("No response body");

        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const events = parseSSEEvents(buffer);
          const lastDoubleNewline = buffer.lastIndexOf("\n\n");
          buffer = lastDoubleNewline >= 0 ? buffer.slice(lastDoubleNewline + 2) : buffer;

          for (const evt of events) {
            if (evt.event === "progress" && activeRequestRef.current === requestId) {
              const p: ImageProgress = JSON.parse(evt.data);
              setProgress(p);
            } else if (evt.event === "result") {
              result = JSON.parse(evt.data);
            }
          }
        }

        if (!result) throw new Error("No result received from server");

        if (result.downloaded > 0 || result.failed > 0) {
          const parts: string[] = [];
          if (result.downloaded > 0) parts.push(`${result.downloaded} image(s) downloaded`);
          if (result.failed > 0) parts.push(`${result.failed} failed`);

          const failedSummary = result.failedUrls?.length
            ? `. Failed: ${result.failedUrls.slice(0, 3).map(formatFailedUrl).join(", ")}${result.failedUrls.length > 3 ? ` +${result.failedUrls.length - 3} more` : ""}`
            : "";

          toast({
            title: result.failed > 0 ? "Images partially processed" : "Images processed",
            description: parts.join(", ") + failedSummary,
            variant: result.failed > 0 ? "destructive" : "default",
          });
        }

        return result.html;
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
          setProgress(null);
          abortRef.current = null;
        }
      }
    },
    [options, cancel, toast],
  );

  return { processing, progress, processHtmlImages, cancel };
}
