import { useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { AlertTriangle, Trash2 } from "lucide-react";

interface ExternalImagesAlertProps {
  imageCount: number;
  hosts: string[];
  tip: string;
  onRemove: () => void;
  disabled?: boolean;
}

export function ExternalImagesAlert({
  imageCount,
  hosts,
  tip,
  onRemove,
  disabled = false,
}: ExternalImagesAlertProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);

  if (imageCount === 0) return null;

  return (
    <>
      <Alert variant="destructive" data-testid="alert-external-images">
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle>External images — blocking</AlertTitle>
        <AlertDescription className="space-y-3">
          <p>
            {imageCount} image{imageCount > 1 ? "s" : ""} use a URL not hosted on the selected MTA's domains. You cannot continue to the next step until they are fixed.
          </p>
          <ul className="list-disc list-inside text-xs font-mono break-all">
            {hosts.slice(0, 8).map((host) => (
              <li key={host} data-testid={`text-external-host-${host}`}>{host}</li>
            ))}
            {hosts.length > 8 && (
              <li>…and {hosts.length - 8} more host(s)</li>
            )}
          </ul>
          <p className="text-xs">{tip}</p>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={() => setConfirmOpen(true)}
            disabled={disabled}
            data-testid="button-remove-external-images"
          >
            <Trash2 className="h-4 w-4 mr-1" />
            Remove blocked image{imageCount > 1 ? "s" : ""}
          </Button>
        </AlertDescription>
      </Alert>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove {imageCount} blocked image{imageCount > 1 ? "s" : ""}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the corresponding image elements from the campaign HTML. Images that were converted successfully or already use the selected MTA's domains will stay in place.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-remove-external-images">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={onRemove}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-remove-external-images"
            >
              Remove images
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}