import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import type { BrandUnsubNotices } from "@/lib/campaign-wizard";

// Brand-unsubscribe notices shown by both campaign wizards (new + edit) from
// the Content → Tracking check until the launch. Information only: nothing
// here disables a button or stops the progression.
export function BrandUnsubscribeNotices({ notices }: { notices: BrandUnsubNotices }) {
  return (
    <>
      {notices.alert && (
        <Alert variant="destructive" data-testid="alert-brand-exceeded">
          <AlertTitle>Alerte : seuil de désabonnements de la marque dépassé</AlertTitle>
          <AlertDescription>{notices.alert}</AlertDescription>
        </Alert>
      )}
      {notices.warning && (
        <Alert className="border-amber-500/60 text-amber-800 dark:text-amber-300 [&>svg]:text-amber-600" data-testid="alert-brand-warning">
          <AlertTitle>Attention</AlertTitle>
          <AlertDescription>{notices.warning}</AlertDescription>
        </Alert>
      )}
      {notices.unavailable && (
        <Alert data-testid="alert-brand-check-unavailable">
          <AlertTitle>Désabonnements de la marque non vérifiés</AlertTitle>
          <AlertDescription>
            Impossible de vérifier actuellement les désabonnements récents de cette marque. L'envoi reste possible ; revenez à l'étape précédente et cliquez à nouveau sur Next pour réessayer.
          </AlertDescription>
        </Alert>
      )}
    </>
  );
}
