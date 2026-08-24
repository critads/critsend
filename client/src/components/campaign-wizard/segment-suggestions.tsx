import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { apiRequest } from "@/lib/queryClient";
import { MousePointerClick } from "lucide-react";

type SegmentSuggestionResponse = {
  brand: string | null;
  campaignsConsidered: number;
  suggestions: Array<{
    segmentId: string;
    segmentName: string;
    totalClicks: number;
    campaignCount: number;
  }>;
};

/**
 * Optional segment choices based on the highest total-click segments used by
 * the latest sent campaigns for the exact campaign-name brand.
 */
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
          Top segments by total clicks from the last {data.campaignsConsidered} sent
          {data.campaignsConsidered === 1 ? " campaign" : " campaigns"} for “{data.brand}”.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {data.suggestions.map((suggestion) => (
          <Button
            key={suggestion.segmentId}
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onSelect(suggestion.segmentId)}
            data-testid={`button-segment-suggestion-${suggestion.segmentId}`}
          >
            <MousePointerClick className="mr-2 h-4 w-4" />
            {suggestion.segmentName}
            <span className="ml-2 text-muted-foreground">{suggestion.totalClicks.toLocaleString()} clicks</span>
          </Button>
        ))}
      </div>
    </div>
  );
}