import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  orangeWanadooStatusPresentation,
  type OrangeWanadooStatusCampaign,
} from "@/lib/orange-wanadoo-status";

export function OrangeWanadooStatusDot({ campaign }: { campaign: OrangeWanadooStatusCampaign }) {
  const presentation = orangeWanadooStatusPresentation(campaign);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          role="img"
          aria-label={presentation.details}
          className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          data-testid={presentation.testId}
        >
          <span aria-hidden="true" className={`h-2 w-2 rounded-full ${presentation.dotClassName}`} />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top"><p className="max-w-64">{presentation.details}</p></TooltipContent>
    </Tooltip>
  );
}