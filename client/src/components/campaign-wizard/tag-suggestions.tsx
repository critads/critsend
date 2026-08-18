import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { Loader2, Wand2 } from "lucide-react";

/**
 * Task #237 — "Suggest from history" button for the campaign wizard's
 * Tracking step. Calls /api/campaigns/tag-suggestions with the campaign name,
 * fills open/click/unsubscribe tags with the most frequent tags used by past
 * campaigns of the same brand (brand = dominant token of the name), and shows
 * how many similar campaigns the suggestion is based on. Never overwrites
 * anything without an explicit click.
 */
interface TagSuggestionsResponse {
  brand: string | null;
  matches: number;
  suggestions: {
    openTag: string | null;
    clickTag: string | null;
    unsubscribeTag: string | null;
  } | null;
}

export function TagSuggestionsButton({
  campaignName,
  excludeId,
  onApply,
}: {
  campaignName: string | undefined | null;
  /** Current campaign id (edit page) so it doesn't suggest from itself. */
  excludeId?: string;
  onApply: (tags: { openTag?: string; clickTag?: string; unsubscribeTag?: string }) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [basis, setBasis] = useState<{ brand: string; matches: number } | null>(null);
  const { toast } = useToast();

  const suggest = async () => {
    const name = (campaignName || "").trim();
    if (!name) {
      toast({
        title: "Campaign name required",
        description: "Enter the campaign name (step 1) first — suggestions are based on it.",
        variant: "destructive",
      });
      return;
    }
    setLoading(true);
    try {
      const params = new URLSearchParams({ name });
      if (excludeId) params.set("excludeId", excludeId);
      const res = await apiRequest("GET", `/api/campaigns/tag-suggestions?${params.toString()}`);
      const data: TagSuggestionsResponse = await res.json();
      const s = data.suggestions;
      const hasAny = !!(s && (s.openTag || s.clickTag || s.unsubscribeTag));
      if (!data.matches || !hasAny) {
        setBasis(null);
        toast({
          title: "No suggestions found",
          description: data.matches
            ? `Found ${data.matches} similar campaign(s) ("${data.brand}"), but none had tags set.`
            : "No past campaigns with a similar brand name were found.",
        });
        return;
      }
      onApply({
        ...(s!.openTag ? { openTag: s!.openTag } : {}),
        ...(s!.clickTag ? { clickTag: s!.clickTag } : {}),
        ...(s!.unsubscribeTag ? { unsubscribeTag: s!.unsubscribeTag } : {}),
      });
      setBasis({ brand: data.brand || "", matches: data.matches });
      toast({
        title: "Tags suggested",
        description: `Based on ${data.matches} past "${data.brand}" campaign(s).`,
      });
    } catch {
      toast({
        title: "Suggestion failed",
        description: "Could not fetch tag suggestions. Please try again.",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex items-center gap-3 flex-wrap">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={suggest}
        disabled={loading}
        data-testid="button-suggest-tags"
      >
        {loading ? (
          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
        ) : (
          <Wand2 className="h-4 w-4 mr-2" />
        )}
        Suggest tags from history
      </Button>
      {basis && (
        <p className="text-xs text-muted-foreground" data-testid="text-tag-suggestion-basis">
          Based on {basis.matches} past "{basis.brand}" campaign(s)
        </p>
      )}
    </div>
  );
}
