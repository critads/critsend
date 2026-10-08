import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { parseSmartSegmentApiError } from "@/lib/smart-segment-ui";
import { cn } from "@/lib/utils";
import {
  PREHEADER_RECOMMENDED_MAX,
  PREHEADER_RECOMMENDED_MIN,
  type PreheaderSuggestionsResponse,
} from "@shared/preheader-suggestions";
import { Check, Loader2, RefreshCw, Sparkles, X } from "lucide-react";

/**
 * « Proposer avec l'IA » for the Preheader field of the campaign wizard
 * (Content step). One click sends the subject + the newsletter HTML to
 * /api/campaigns/preheader-suggestions and shows the 5 preheaders returned;
 * clicking one fills the input. Nothing is written without a click, and the
 * operator can still edit the text afterwards.
 */
export function PreheaderSuggestions({
  subject,
  htmlContent,
  campaignName,
  value,
  onSelect,
}: {
  subject: string;
  htmlContent: string;
  campaignName?: string | null;
  /** Current preheader, to highlight the suggestion in use. */
  value: string;
  onSelect: (preheader: string) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<PreheaderSuggestionsResponse | null>(null);
  const { toast } = useToast();
  const hasContent = htmlContent.trim().length > 0;

  const suggest = async () => {
    if (!hasContent) {
      toast({
        title: "Contenu HTML requis",
        description: "Chargez d'abord le HTML de la newsletter : les preheaders sont déduits de son contenu.",
        variant: "destructive",
      });
      return;
    }
    setLoading(true);
    try {
      const res = await apiRequest("POST", "/api/campaigns/preheader-suggestions", {
        subject,
        htmlContent,
        ...(campaignName?.trim() ? { campaignName: campaignName.trim() } : {}),
      });
      const data: PreheaderSuggestionsResponse = await res.json();
      setResult(data);
    } catch (error) {
      const parsed = parseSmartSegmentApiError(error);
      toast({
        title: parsed.status === 503 ? "IA non configurée" : "Suggestion impossible",
        description: parsed.message,
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-2" data-testid="preheader-suggestions">
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={suggest}
          disabled={loading || !hasContent}
          title={hasContent ? "Analyser la newsletter et proposer 5 preheaders" : "Chargez d'abord le HTML de la newsletter"}
          data-testid="button-preheader-suggest"
        >
          {loading ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : result ? <RefreshCw className="h-4 w-4 mr-1" /> : <Sparkles className="h-4 w-4 mr-1" />}
          {loading ? "Analyse de la newsletter…" : result ? "Proposer d'autres preheaders" : "Proposer avec l'IA"}
        </Button>
        {result && !loading && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setResult(null)}
            aria-label="Masquer les suggestions"
            data-testid="button-preheader-suggestions-close"
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>

      {result && <PreheaderSuggestionList result={result} value={value} onSelect={onSelect} />}
    </div>
  );
}

/** The list itself (presentational, rendered once the server answered). */
export function PreheaderSuggestionList({
  result,
  value,
  onSelect,
}: {
  result: PreheaderSuggestionsResponse;
  value: string;
  onSelect: (preheader: string) => void;
}) {
  const lengthTone = (length: number) =>
    length < PREHEADER_RECOMMENDED_MIN || length > PREHEADER_RECOMMENDED_MAX ? "text-amber-600" : "text-muted-foreground";
  return (
    <div className="rounded-md border bg-muted/30 p-3 space-y-2" data-testid="preheader-suggestions-list">
      <p className="text-xs text-muted-foreground">
        Cliquez sur une proposition pour l'utiliser — vous pourrez encore la modifier.
        {result.language ? ` Langue détectée : ${result.language.toUpperCase()}.` : ""}
      </p>
      <ul className="space-y-1.5">
        {result.suggestions.map((suggestion, index) => {
          const selected = value.trim() === suggestion.text;
          return (
            <li key={`${index}-${suggestion.text}`}>
              <button
                type="button"
                onClick={() => onSelect(suggestion.text)}
                className={cn(
                  "w-full text-left rounded-md border px-3 py-2 text-sm transition-colors hover:bg-accent",
                  selected ? "border-primary bg-primary/5" : "bg-background",
                )}
                aria-pressed={selected}
                data-testid={`button-preheader-suggestion-${index}`}
              >
                <div className="flex items-start gap-2">
                  <span className="flex-1">{suggestion.text}</span>
                  {selected && <Check className="h-4 w-4 text-primary shrink-0 mt-0.5" />}
                </div>
                <div className="mt-1 flex items-center gap-2">
                  {suggestion.angle && (
                    <Badge variant="secondary" className="text-[10px] font-normal">{suggestion.angle}</Badge>
                  )}
                  <span className={cn("text-[11px]", lengthTone(suggestion.text.length))}>
                    {suggestion.text.length} caractères
                  </span>
                </div>
              </button>
            </li>
          );
        })}
      </ul>
      {result.notes.length > 0 && (
        <ul className="text-xs text-muted-foreground list-disc pl-4">
          {result.notes.map((note, index) => <li key={index}>{note}</li>)}
        </ul>
      )}
    </div>
  );
}
