import { useState, useRef } from "react";
import { Bug, Camera, Loader2, X } from "lucide-react";
import html2canvas from "html2canvas";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";

async function captureScreenshot(): Promise<Blob | null> {
  try {
    const canvas = await html2canvas(document.body, {
      logging: false,
      useCORS: true,
      allowTaint: true,
      windowWidth: document.documentElement.clientWidth,
      windowHeight: document.documentElement.clientHeight,
      scale: Math.min(window.devicePixelRatio || 1, 1.5),
    });
    return await new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), "image/png", 0.85));
  } catch (e) {
    console.error("html2canvas failed", e);
    return null;
  }
}

export function BugReportButton() {
  const { toast } = useToast();
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState("");
  const [screenshot, setScreenshot] = useState<Blob | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const previewUrlRef = useRef<string | null>(null);

  const setPreview = (blob: Blob | null) => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    if (blob) {
      const url = URL.createObjectURL(blob);
      previewUrlRef.current = url;
      setPreviewUrl(url);
    } else {
      previewUrlRef.current = null;
      setPreviewUrl(null);
    }
    setScreenshot(blob);
  };

  const handleOpen = async () => {
    // Capture FIRST, before the dialog backdrop renders, so the screenshot
    // shows the page as the user actually sees it.
    setCapturing(true);
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    const blob = await captureScreenshot();
    setPreview(blob);
    setCapturing(false);
    setOpen(true);
  };

  const handleRetake = async () => {
    setOpen(false);
    setCapturing(true);
    // Wait for dialog overlay to fully unmount, then a paint, before capturing
    await new Promise((r) => setTimeout(r, 350));
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    const blob = await captureScreenshot();
    setPreview(blob);
    setCapturing(false);
    setOpen(true);
  };

  const handleClose = (next: boolean) => {
    if (!next) {
      setDescription("");
      setPreview(null);
    }
    setOpen(next);
  };

  const handleSubmit = async () => {
    if (!description.trim()) {
      toast({ title: "Description required", description: "Please describe the issue.", variant: "destructive" });
      return;
    }
    setSubmitting(true);
    try {
      let screenshotPath: string | null = null;
      if (screenshot) {
        try {
          const r = await apiRequest("POST", "/api/bug-reports/upload-url", {});
          const { uploadURL, objectPath } = await r.json();
          const putRes = await fetch(uploadURL, {
            method: "PUT",
            headers: { "Content-Type": "image/png" },
            body: screenshot,
          });
          if (putRes.ok) {
            screenshotPath = objectPath;
          } else {
            console.warn("screenshot upload failed", putRes.status);
          }
        } catch (e) {
          console.warn("screenshot upload error", e);
        }
      }

      await apiRequest("POST", "/api/bug-reports", {
        description: description.trim(),
        screenshotPath,
        pageUrl: window.location.href.slice(0, 2000),
        userAgent: navigator.userAgent.slice(0, 1000),
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        userEmail: user?.username ?? null,
      });

      toast({ title: "Bug report submitted", description: "Thanks — your report was sent to the team." });
      handleClose(false);
    } catch (e: any) {
      toast({ title: "Failed to submit", description: e?.message || "Please try again.", variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            size="icon"
            onClick={handleOpen}
            className="fixed bottom-6 right-6 z-40 h-12 w-12 rounded-full shadow-lg"
            aria-label="Report a bug"
            data-testid="button-bug-report-open"
          >
            <Bug className="h-5 w-5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="left">Report a bug</TooltipContent>
      </Tooltip>

      <Dialog open={open} onOpenChange={handleClose}>
        <DialogContent className="max-w-lg" data-testid="dialog-bug-report">
          <DialogHeader>
            <DialogTitle>Report a bug</DialogTitle>
            <DialogDescription>
              Describe what went wrong. We'll attach a screenshot of this page automatically.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <Textarea
              placeholder="What happened? What did you expect?"
              rows={5}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={5000}
              data-testid="input-bug-report-description"
            />

            <div className="rounded-md border bg-muted/40 p-2">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-muted-foreground">Screenshot</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={handleRetake}
                  disabled={capturing || submitting}
                  data-testid="button-bug-report-retake"
                >
                  {capturing ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Camera className="h-3 w-3 mr-1" />}
                  Retake
                </Button>
              </div>
              {capturing ? (
                <div className="flex items-center justify-center h-32 text-muted-foreground text-sm">
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Capturing…
                </div>
              ) : previewUrl ? (
                <div className="relative">
                  <img src={previewUrl} alt="Screenshot preview" className="w-full max-h-48 object-contain rounded border" data-testid="img-bug-report-preview" />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="absolute top-1 right-1 h-6 w-6 bg-background/80"
                    onClick={() => setPreview(null)}
                    title="Remove screenshot"
                    data-testid="button-bug-report-remove-screenshot"
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </div>
              ) : (
                <div className="flex items-center justify-center h-32 text-muted-foreground text-sm">
                  No screenshot attached
                </div>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => handleClose(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button
              type="button"
              onClick={handleSubmit}
              disabled={submitting || capturing || !description.trim()}
              data-testid="button-bug-report-submit"
            >
              {submitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Submit report
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
