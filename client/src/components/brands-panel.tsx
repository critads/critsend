import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertCircle, ChevronLeft, ChevronRight, Download, FileUp, Plus, Search, Upload, X } from "lucide-react";
import { apiRequest, fetchCsrfToken, invalidateCsrfToken, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

interface Brand {
  id: string;
  name: string;
  ref: string;
  createdAt: string;
}

interface BrandsResponse {
  brands: Brand[];
  total: number;
  page: number;
  totalPages: number;
}

const PAGE_SIZE = 25;
const MAX_FILE_SIZE = 5 * 1024 * 1024;

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message.replace(/^\d+:\s*/, "") : fallback;
}

export function BrandsPanel() {
  const { toast } = useToast();
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [name, setName] = useState("");
  const [ref, setRef] = useState("");
  const [formError, setFormError] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  const queryKey = ["/api/brands", { search, page, limit: PAGE_SIZE }];
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<BrandsResponse>({
    queryKey,
    queryFn: async () => {
      const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
      if (search) params.set("search", search);
      const response = await fetch(`/api/brands?${params}`, { credentials: "include" });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error || "Unable to load brands.");
      }
      return response.json();
    },
  });

  useEffect(() => {
    if (data && page > Math.max(1, data.totalPages)) setPage(Math.max(1, data.totalPages));
  }, [data, page]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["/api/brands"] });
  const createBrand = useMutation({
    mutationFn: ({ brandName, brandRef }: { brandName: string; brandRef: string }) =>
      apiRequest("POST", "/api/brands", { name: brandName, ref: brandRef }),
    onSuccess: () => {
      setAddOpen(false);
      setName("");
      setRef("");
      setFormError("");
      setPage(1);
      refresh();
      toast({ title: "Brand added", description: "The brand is ready to use." });
    },
    onError: (mutationError) => setFormError(errorMessage(mutationError, "Unable to add this brand.")),
  });

  const importBrands = useMutation({
    mutationFn: async (csv: File) => {
      const formData = new FormData();
      formData.append("file", csv);
      const send = async () => fetch("/api/brands/import", {
        method: "POST",
        headers: { "x-csrf-token": await fetchCsrfToken() },
        body: formData,
        credentials: "include",
      });
      let response = await send();
      if (response.status === 403) {
        const text = await response.clone().text();
        if (text.toLowerCase().includes("csrf")) {
          invalidateCsrfToken();
          response = await send();
        }
      }
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error || "The CSV could not be imported.");
      }
      return response.json() as Promise<{ created: number; skipped: number; total: number }>;
    },
    onSuccess: (result) => {
      setImportOpen(false);
      setFile(null);
      setFileError("");
      if (inputRef.current) inputRef.current.value = "";
      setPage(1);
      refresh();
      toast({
        title: "Import complete",
        description: `${result.created.toLocaleString()} created · ${result.skipped.toLocaleString()} skipped of ${result.total.toLocaleString()} rows.`,
      });
    },
    onError: (mutationError) => setFileError(errorMessage(mutationError, "The CSV could not be imported.")),
  });

  const submitBrand = () => {
    const trimmedName = name.trim();
    const trimmedRef = ref.trim();
    if (!trimmedName || !trimmedRef) {
      setFormError("Brand name and REF are required.");
      return;
    }
    setFormError("");
    createBrand.mutate({ brandName: trimmedName, brandRef: trimmedRef });
  };

  const selectFile = (event: ChangeEvent<HTMLInputElement>) => {
    const selected = event.target.files?.[0];
    if (!selected) return;
    if (!selected.name.toLowerCase().endsWith(".csv")) {
      setFileError("Choose a CSV file.");
      setFile(null);
      event.target.value = "";
      return;
    }
    if (selected.size === 0 || selected.size > MAX_FILE_SIZE) {
      setFileError("Choose a non-empty CSV up to 5 MB.");
      setFile(null);
      event.target.value = "";
      return;
    }
    setFileError("");
    setFile(selected);
  };

  const downloadTemplate = () => {
    const blob = new Blob(["brand,ref\nNorthstar Studio,northstar\n"], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "brands-template.csv";
    link.click();
    URL.revokeObjectURL(url);
  };

  const brands = data?.brands ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, data?.totalPages ?? 1);

  return (
    <div className="space-y-6" data-testid="brands-panel">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Brands</h2>
          <p className="text-muted-foreground">Maintain the brand and REF directory used across your workspace.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => { setFileError(""); setImportOpen(true); }} data-testid="button-import-brands">
            <Upload className="mr-2 h-4 w-4" />Import CSV
          </Button>
          <Button onClick={() => { setFormError(""); setAddOpen(true); }} data-testid="button-add-brand">
            <Plus className="mr-2 h-4 w-4" />Add brand
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:w-80">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={searchInput} onChange={(event) => setSearchInput(event.target.value)} className="pl-9" placeholder="Search brand or REF..." aria-label="Search brands and references" data-testid="input-search-brands" />
        </div>
        <p className="text-sm text-muted-foreground" aria-live="polite">{isFetching ? "Updating…" : `${total.toLocaleString()} brand${total === 1 ? "" : "s"}`}</p>
      </div>

      <div className="overflow-hidden rounded-md border">
        <Table>
          <TableHeader><TableRow><TableHead>Brand</TableHead><TableHead>REF</TableHead><TableHead className="hidden sm:table-cell">Added</TableHead></TableRow></TableHeader>
          <TableBody>
            {isLoading ? Array.from({ length: 5 }).map((_, index) => (
              <TableRow key={index}><TableCell><Skeleton className="h-4 w-44" /></TableCell><TableCell><Skeleton className="h-4 w-24" /></TableCell><TableCell className="hidden sm:table-cell"><Skeleton className="h-4 w-20" /></TableCell></TableRow>
            )) : isError ? (
              <TableRow><TableCell colSpan={3} className="py-12 text-center"><AlertCircle className="mx-auto mb-3 h-8 w-8 text-destructive" /><p className="font-medium">Couldn’t load brands</p><p className="mt-1 text-sm text-muted-foreground">{errorMessage(error, "Please try again.")}</p><Button className="mt-4" variant="outline" onClick={() => refetch()}>Try again</Button></TableCell></TableRow>
            ) : brands.length ? brands.map((brand) => (
              <TableRow key={brand.id} data-testid={`brand-row-${brand.id}`}><TableCell className="font-medium">{brand.name}</TableCell><TableCell className="font-mono text-sm text-muted-foreground">{brand.ref}</TableCell><TableCell className="hidden text-sm text-muted-foreground sm:table-cell">{new Date(brand.createdAt).toLocaleDateString()}</TableCell></TableRow>
            )) : (
              <TableRow><TableCell colSpan={3} className="py-14 text-center"><FileUp className="mx-auto mb-3 h-9 w-9 text-muted-foreground/50" /><p className="font-medium">{search ? "No matching brands" : "No brands yet"}</p><p className="mt-1 text-sm text-muted-foreground">{search ? "Try a different brand name or REF." : "Add one manually or import a CSV to get started."}</p></TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {!isLoading && !isError && total > 0 && <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">Showing {((page - 1) * PAGE_SIZE + 1).toLocaleString()}–{Math.min(page * PAGE_SIZE, total).toLocaleString()} of {total.toLocaleString()}</p>
        <div className="flex items-center gap-2"><Button size="sm" variant="outline" onClick={() => setPage(page - 1)} disabled={page === 1}><ChevronLeft className="mr-1 h-4 w-4" />Previous</Button><span className="text-sm text-muted-foreground">Page {page} of {totalPages}</span><Button size="sm" variant="outline" onClick={() => setPage(page + 1)} disabled={page >= totalPages}>Next<ChevronRight className="ml-1 h-4 w-4" /></Button></div>
      </div>}

      <Dialog open={addOpen} onOpenChange={setAddOpen}><DialogContent><DialogHeader><DialogTitle>Add brand</DialogTitle><DialogDescription>Create a brand record with its unique reference.</DialogDescription></DialogHeader><div className="space-y-4"><div className="space-y-2"><Label htmlFor="brand-name">Brand name</Label><Input id="brand-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Northstar Studio" autoFocus /></div><div className="space-y-2"><Label htmlFor="brand-ref">REF</Label><Input id="brand-ref" value={ref} onChange={(event) => setRef(event.target.value)} placeholder="e.g. northstar" /></div>{formError && <p className="text-sm text-destructive" role="alert">{formError}</p>}</div><DialogFooter><Button variant="outline" onClick={() => setAddOpen(false)}>Cancel</Button><Button onClick={submitBrand} disabled={createBrand.isPending}>{createBrand.isPending ? "Adding..." : "Add brand"}</Button></DialogFooter></DialogContent></Dialog>

      <Dialog open={importOpen} onOpenChange={setImportOpen}><DialogContent><DialogHeader><DialogTitle>Import brands</DialogTitle><DialogDescription>Upload a UTF-8 CSV to add multiple brands at once.</DialogDescription></DialogHeader><div className="space-y-4"><div className="rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground"><p className="font-medium text-foreground">File requirements</p><ul className="mt-2 list-disc space-y-1 pl-5"><li>Headers: <code>brand,ref</code></li><li>Comma or semicolon separated CSV, UTF-8</li><li>Up to 5 MB and 10,000 rows</li></ul><Button variant="ghost" className="mt-2 h-auto p-0 text-primary hover:bg-transparent hover:underline" onClick={downloadTemplate}><Download className="mr-1 h-3.5 w-3.5" />Download template</Button></div><Label htmlFor="brands-csv" className="sr-only">CSV file</Label><Input ref={inputRef} id="brands-csv" type="file" accept=".csv,text/csv" onChange={selectFile} disabled={importBrands.isPending} />{file && <div className="flex items-center justify-between rounded-md border px-3 py-2 text-sm"><span className="truncate">{file.name}</span><Button variant="ghost" size="icon" onClick={() => { setFile(null); if (inputRef.current) inputRef.current.value = ""; }} disabled={importBrands.isPending}><X className="h-4 w-4" /></Button></div>}{fileError && <p className="text-sm text-destructive" role="alert">{fileError}</p>}</div><DialogFooter><Button variant="outline" onClick={() => setImportOpen(false)}>Cancel</Button><Button onClick={() => file ? importBrands.mutate(file) : setFileError("Choose a CSV file to continue.")} disabled={!file || importBrands.isPending}>{importBrands.isPending ? "Importing..." : "Import brands"}</Button></DialogFooter></DialogContent></Dialog>
    </div>
  );
}