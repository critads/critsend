import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { apiRequest } from "@/lib/queryClient";
import { MousePointerClick } from "lucide-react";

type SegmentSuggestionResponse = {
  brand: string | null;
  campaignsConsidered: number;
  strategy: "performance" | "recent_use";
  suggestions: Array<{
    segmentId: string;
    segmentName: string;
    totalClicks: number;
    campaignCount: number;
    deliveredCount: number;
    clickRate: number;
    smoothedClickRate: number;
    lastUsedAt: string;
    evidence: "performance" | "recent_use";
    metricScope: "campaigns_using_segment";
  }>;
};

const numberFormat = new Intl.NumberFormat("en-US");

function recencyLabel(value: string): string {
  const ageDays = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 86_400_000));
  if (ageDays === 0) return "today";
  if (ageDays === 1) return "1 day ago";
  return `${ageDays} days ago`;
}

export function SegmentSuggestions({
  campaignName,
  excludeId,
  onSelect,
}: {
  campaignName: string | undefined | null;
  excludeId?: string | null;
  onSelect: (segmentId: string) => void;
}) {
  const name = (campaignName || "").trim();
  const { data, isLoading } = useQuery({
    queryKey: ["/api/campaigns/segment-suggestions", { name, excludeId: excludeId || undefined }],
    enabled: name.length > 0,
    staleTime: 5 * 60 * 1000,
    retry: false,
    queryFn: async () => {
      const params = new URLSearchParams({ name });
      if (excludeId) params.set("excludeId", excludeId);
      const response = await apiRequest("GET", `/api/campaigns/segment-suggestions?${params}`);
      return response.json() as Promise<SegmentSuggestionResponse>;
    },
  });

  if (!name || (!isLoading && (!data || data.suggestions.length === 0))) {
    return null;
  }

  if (isLoading) {
    return (
      <div className="space-y-2" aria-label="Loading segment suggestions">
        <Skeleton className="h-4 w-52" />
        <Skeleton className="h-9 w-full" />
      </div>
    );
  }

  // React Query can enter an error/refetch state without data. Suggestions are
  // deliberately non-blocking, so silently omit this optional panel then.
  if (!data || data.suggestions.length === 0) {
    return null;
  }

  return (
    <div className="rounded-lg border bg-muted/30 p-4 space-y-3" data-testid="segment-suggestions">
      <div>
        <p className="font-medium">Suggested segments</p>
        <p className="text-sm text-muted-foreground">
          {data.strategy === "performance"
            ? `Ranked by repeatable results from campaigns where each segment was used, across ${data.campaignsConsidered} sent ${data.campaignsConsidered === 1 ? "campaign" : "campaigns"} for “${data.brand}”.`
            : `Not enough performance history yet; showing the most recently used segments for “${data.brand}”.`}
        </p>
      </div>
      <div className="grid gap-2">
        {data.suggestions.map((suggestion) => (
          <Button
            key={suggestion.segmentId}
            type="button"
            variant="outline"
            onClick={() => onSelect(suggestion.segmentId)}
            className="h-auto min-h-10 justify-start whitespace-normal py-2 text-left"
            data-testid={`button-segment-suggestion-${suggestion.segmentId}`}
          >
            <MousePointerClick className="mr-2 h-4 w-4 shrink-0" />
            <span>
              <span className="font-medium">{suggestion.segmentName}</span>
              <span className="ml-2 text-xs text-muted-foreground">
                {suggestion.campaignCount} {suggestion.campaignCount === 1 ? "use" : "uses"}
                {" · "}{numberFormat.format(suggestion.deliveredCount)} campaign deliveries
                {" · "}{suggestion.clickRate.toFixed(2)}% campaign CTR
                {" · "}last used {recencyLabel(suggestion.lastUsedAt)}
              </span>
            </span>
          </Button>
        ))}
      </div>
    </div>
  );
}