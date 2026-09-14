import { useQuery } from "@tanstack/react-query";
import { Check, ChevronsUpDown, Loader2 } from "lucide-react";
import { useState } from "react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiRequest } from "@/lib/queryClient";
import { cn } from "@/lib/utils";

const REF_BRAND_PAGE_SIZE = 25;

export interface RefBrand {
  id: string;
  name: string;
  ref: string;
}

interface RefBrandResponse {
  brands: RefBrand[];
  total: number;
  page: number;
  totalPages: number;
}

export function refBrandSearchUrl(search: string): string {
  const params = new URLSearchParams();
  params.set("search", search.trim());
  params.set("page", "1");
  params.set("limit", String(REF_BRAND_PAGE_SIZE));
  return `/api/brands?${params.toString()}`;
}

export function RefBrandInput({
  value,
  onChange,
  placeholder = "Ref value...",
  testId,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  testId: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [selectedBrand, setSelectedBrand] = useState<RefBrand | null>(null);

  const { data, isLoading, isError, error } = useQuery<RefBrandResponse>({
    queryKey: ["/api/brands/ref-selector", search.trim()],
    enabled: open,
    staleTime: 30_000,
    queryFn: async ({ signal }) => {
      const response = await apiRequest("GET", refBrandSearchUrl(search), undefined, signal);
      return await response.json() as RefBrandResponse;
    },
  });

  const brands = data?.brands ?? [];
  const selected = selectedBrand && selectedBrand.ref === value ? selectedBrand : null;
  const errorText = error instanceof Error ? error.message : "Unable to load brands.";

  return (
    <div className="flex min-w-[250px] flex-1 items-center gap-2">
      <Input
        value={value}
        placeholder={placeholder}
        onChange={(event) => {
          setSelectedBrand(null);
          onChange(event.target.value);
        }}
        className="min-w-0 flex-1"
        data-testid={testId}
      />
      <Popover
        open={open}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          if (nextOpen) setSearch("");
        }}
      >
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            aria-label="Choose a brand to fill REF"
            className="min-w-0 max-w-[230px] flex-1 justify-between font-normal"
            data-testid={`${testId}-brand-picker`}
          >
            <span className={cn("truncate", !selected && "text-muted-foreground")}>
              {selected ? `${selected.name} · REF: ${selected.ref}` : "Choose brand…"}
            </span>
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[--radix-popover-trigger-width] min-w-[280px] p-0" align="start">
          <Command shouldFilter={false}>
            <CommandInput
              placeholder="Search brands or REF..."
              value={search}
              onValueChange={setSearch}
              data-testid={`${testId}-brand-search`}
            />
            <CommandList>
              {isError ? (
                <div className="space-y-1 px-3 py-6 text-center text-sm text-destructive" role="alert">
                  <p>Unable to load brands.</p>
                  <p className="text-xs text-muted-foreground">{errorText}</p>
                </div>
              ) : isLoading ? (
                <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground" role="status">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading brands…
                </div>
              ) : (
                <>
                  <CommandEmpty>
                    {search.trim() ? "No matching brands" : "No brands available"}
                  </CommandEmpty>
                  <CommandGroup>
                    {brands.map((brand) => (
                      <CommandItem
                        key={brand.id}
                        value={`${brand.name} ${brand.ref}`}
                        aria-label={`${brand.name} · REF: ${brand.ref}`}
                        onSelect={() => {
                          setSelectedBrand(brand);
                          onChange(brand.ref);
                          setOpen(false);
                        }}
                      >
                        <Check
                          className={cn(
                            "mr-2 h-4 w-4 shrink-0",
                            selected?.id === brand.id ? "opacity-100" : "opacity-0",
                          )}
                        />
                        <span className="min-w-0 truncate">
                          {brand.name} <span className="text-muted-foreground">· REF: {brand.ref}</span>
                        </span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                  {data && data.total > REF_BRAND_PAGE_SIZE && (
                    <p className="border-t px-3 py-2 text-xs text-muted-foreground">
                      More than {REF_BRAND_PAGE_SIZE} brands match. Refine your search to see a specific brand.
                    </p>
                  )}
                </>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}