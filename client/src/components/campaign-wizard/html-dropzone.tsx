import { Button } from "@/components/ui/button";
import { Upload, Loader2, X } from "lucide-react";
import type { ImageProgress } from "@/hooks/use-html-image-processor";

interface HtmlDropzoneProps {
  isDragging: boolean;
  setIsDragging: (dragging: boolean) => void;
  onDrop: (e: React.DragEvent<HTMLDivElement>) => void;
  onFileSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  processing: boolean;
  progress: ImageProgress | null;
  onCancel: () => void;
}

/** Drag-and-drop / browse zone for uploading the campaign HTML file, including
 *  the image-processing progress + cancel state. Shared verbatim between the
 *  campaign-new and campaign-edit wizards (identical markup and data-testids). */
export function HtmlDropzone({
  isDragging,
  setIsDragging,
  onDrop,
  onFileSelect,
  processing,
  progress,
  onCancel,
}: HtmlDropzoneProps) {
  return (
    <div
      className={`border-2 border-dashed rounded-md p-8 text-center transition-colors ${
        isDragging
          ? "border-primary bg-primary/5"
          : "border-muted-foreground/25 hover:border-muted-foreground/50"
      }`}
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={onDrop}
      data-testid="dropzone-html"
    >
      {processing ? (
        <>
          <Loader2 className="h-12 w-12 mx-auto mb-4 text-muted-foreground animate-spin" />
          <p className="text-lg font-medium mb-2">Processing images...</p>
          {progress ? (
            <div className="w-48 mx-auto mb-4">
              <div className="flex justify-between text-sm text-muted-foreground mb-1">
                <span data-testid="text-image-progress">{progress.processed} of {progress.total}</span>
                <span>{Math.round((progress.processed / progress.total) * 100)}%</span>
              </div>
              <div className="h-2 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary rounded-full transition-all duration-300"
                  style={{ width: `${(progress.processed / progress.total) * 100}%` }}
                  data-testid="progress-bar-images"
                />
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground mb-4">
              Downloading and saving images locally
            </p>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onCancel}
            data-testid="button-cancel-image-processing"
          >
            <X className="h-4 w-4 mr-1" />
            Cancel
          </Button>
        </>
      ) : (
        <>
          <Upload className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
          <p className="text-lg font-medium mb-2">Drop your HTML file here</p>
          <p className="text-sm text-muted-foreground mb-4">
            or click to browse for a file
          </p>
          <input
            type="file"
            accept=".html,.htm,text/html"
            onChange={onFileSelect}
            className="hidden"
            id="html-file-input"
            data-testid="input-html-file"
          />
          <Button
            type="button"
            variant="outline"
            onClick={() => document.getElementById("html-file-input")?.click()}
            data-testid="button-browse-html"
          >
            <Upload className="h-4 w-4 mr-2" />
            Browse Files
          </Button>
        </>
      )}
    </div>
  );
}
