import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useJobStream } from "@/hooks/use-job-stream";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import { Label } from "@/components/ui/label";
import { 
  Search, 
  MoreVertical, 
  Trash2, 
  ChevronLeft, 
  ChevronRight,
  Users,
  Tag,
  X,
  Plus,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Filter,
  ShieldBan,
} from "lucide-react";
import type { Subscriber } from "@shared/schema";

interface SubscribersResponse {
  subscribers: Subscriber[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export default function Subscribers() {
  useJobStream();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [editingSubscriber, setEditingSubscriber] = useState<Subscriber | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<Subscriber | null>(null);
  const [newTag, setNewTag] = useState("");
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [newSubscriberEmail, setNewSubscriberEmail] = useState("");
  const [newSubscriberTags, setNewSubscriberTags] = useState<string[]>([]);
  const [newSubscriberTag, setNewSubscriberTag] = useState("");
  const [showFlushConfirm, setShowFlushConfirm] = useState(false);
  const [flushJobId, setFlushJobId] = useState<string | null>(null);
  const [showSaveSegmentDialog, setShowSaveSegmentDialog] = useState(false);
  const [segmentName, setSegmentName] = useState("");
  const { toast } = useToast();

  const { data, isLoading } = useQuery<SubscribersResponse>({
    queryKey: ["/api/subscribers", page, search],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set("page", page.toString());
      if (search) params.set("search", search);
      const res = await fetch(`/api/subscribers?${params.toString()}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to fetch subscribers");
      return res.json();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/subscribers/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/subscribers"] });
      setDeleteConfirm(null);
      toast({
        title: "Subscriber deleted",
        description: "The subscriber has been removed from your list.",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to delete subscriber. Please try again.",
        variant: "destructive",
      });
    },
  });

  const updateTagsMutation = useMutation({
    mutationFn: ({ id, tags }: { id: string; tags: string[] }) =>
      apiRequest("PATCH", `/api/subscribers/${id}`, { tags }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/subscribers"] });
      setEditingSubscriber(null);
      toast({
        title: "Tags updated",
        description: "Subscriber tags have been updated successfully.",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to update tags. Please try again.",
        variant: "destructive",
      });
    },
  });

  const createSubscriberMutation = useMutation({
    mutationFn: (data: { email: string; tags: string[] }) =>
      apiRequest("POST", "/api/subscribers", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/subscribers"] });
      setShowAddDialog(false);
      setNewSubscriberEmail("");
      setNewSubscriberTags([]);
      toast({
        title: "Subscriber added",
        description: "The subscriber has been added to your list.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message.includes("409") 
          ? "This email already exists in your list." 
          : "Failed to add subscriber. Please try again.",
        variant: "destructive",
      });
    },
  });

  interface FlushJob {
    id: string;
    status: string;
    totalRows: number;
    processedRows: number;
    errorMessage: string | null;
    phase?: string;
  }

  const { data: flushJob } = useQuery<FlushJob>({
    queryKey: ["/api/subscribers/flush", flushJobId],
    queryFn: async () => {
      if (!flushJobId) throw new Error("No job ID");
      const res = await fetch(`/api/subscribers/flush/${flushJobId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch flush job");
      return res.json();
    },
    enabled: !!flushJobId,
    refetchInterval: flushJobId ? 2000 : false,
    select: (freshData) => {
      const cached = queryClient.getQueryData<FlushJob>(["/api/subscribers/flush", flushJobId]);
      if (cached?.phase && !freshData.phase) {
        return { ...freshData, phase: cached.phase };
      }
      return freshData;
    },
  });

  const cancelFlushMutation = useMutation({
    mutationFn: async (jobId: string) => {
      const res = await apiRequest("POST", `/api/subscribers/flush/${jobId}/cancel`);
      return res.json();
    },
    onSuccess: () => {
      setFlushJobId(null);
      setShowFlushConfirm(false);
      queryClient.invalidateQueries({ queryKey: ["/api/subscribers"] });
      toast({
        title: "Deletion cancelled",
        description: "The subscriber deletion was stopped.",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to cancel deletion.",
        variant: "destructive",
      });
    },
  });

  const [flushFinishedState, setFlushFinishedState] = useState<"completed" | "failed" | "cancelled" | null>(null);

  useEffect(() => {
    if (flushJob?.status === "completed") {
      let cancelled = false;
      setFlushFinishedState("completed");
      queryClient.invalidateQueries({ queryKey: ["/api/subscribers"] });
      const finalize = async () => {
        let finalCount = flushJob.processedRows;
        if (flushJobId) {
          try {
            const res = await fetch(`/api/subscribers/flush/${flushJobId}`, { credentials: "include" });
            if (res.ok) {
              const finalJob = await res.json();
              finalCount = finalJob.processedRows ?? finalCount;
            }
          } catch {}
        }
        if (cancelled) return;
        const timer = setTimeout(() => {
          if (cancelled) return;
          setFlushJobId(null);
          setShowFlushConfirm(false);
          setFlushFinishedState(null);
          setPage(1);
          toast({
            title: "All subscribers deleted",
            description: `Successfully deleted ${finalCount.toLocaleString()} subscribers.`,
          });
        }, 3000);
        return timer;
      };
      let timerId: NodeJS.Timeout | undefined;
      finalize().then(t => { timerId = t; });
      return () => { cancelled = true; if (timerId) clearTimeout(timerId); };
    } else if (flushJob?.status === "failed") {
      setFlushFinishedState("failed");
    } else if (flushJob?.status === "cancelled") {
      setFlushFinishedState("cancelled");
      queryClient.invalidateQueries({ queryKey: ["/api/subscribers"] });
      const timer = setTimeout(() => {
        setFlushJobId(null);
        setShowFlushConfirm(false);
        setFlushFinishedState(null);
        toast({
          title: "Deletion cancelled",
          description: `Stopped after deleting ${flushJob.processedRows.toLocaleString()} subscribers.`,
        });
      }, 1500);
      return () => clearTimeout(timer);
    }
  }, [flushJob?.status]);

  const flushAllMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("DELETE", "/api/subscribers");
      return res.json() as Promise<{ jobId: string | null; totalRows: number; message: string }>;
    },
    onSuccess: (response) => {
      if (response.jobId) {
        setFlushFinishedState(null);
        queryClient.setQueryData(["/api/subscribers/flush", response.jobId], {
          id: response.jobId,
          status: "processing",
          processedRows: 0,
          totalRows: response.totalRows,
          errorMessage: null,
          phase: "clearing_dependencies",
        });
        setFlushJobId(response.jobId);
      } else {
        setShowFlushConfirm(false);
        toast({
          title: "No subscribers to delete",
          description: "Your subscriber list is already empty.",
        });
      }
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to start subscriber deletion. Please try again.",
        variant: "destructive",
      });
    },
  });

  const saveAsSegmentMutation = useMutation({
    mutationFn: (data: { name: string; rules: any[] }) =>
      apiRequest("POST", "/api/segments", { name: data.name, description: `Created from search: "${search}"`, rules: data.rules }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/segments"] });
      setShowSaveSegmentDialog(false);
      setSegmentName("");
      toast({
        title: "Segment created",
        description: "Your search has been saved as a segment.",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to create segment. Please try again.",
        variant: "destructive",
      });
    },
  });

  const handleSaveAsSegment = () => {
    if (!segmentName.trim() || !search.trim()) return;
    const searchTerm = search.trim();
    const rules = [
      { field: "email", operator: "contains", value: searchTerm },
      { field: "tags", operator: "contains", value: searchTerm.toUpperCase(), logic: "OR" },
      { field: "refs", operator: "has_ref", value: searchTerm.toUpperCase(), logic: "OR" },
    ];
    saveAsSegmentMutation.mutate({ name: segmentName.trim(), rules });
  };

  const handleAddNewSubscriberTag = () => {
    if (newSubscriberTag.trim()) {
      setNewSubscriberTags([...newSubscriberTags, newSubscriberTag.trim().toUpperCase()]);
      setNewSubscriberTag("");
    }
  };

  const handleRemoveNewSubscriberTag = (tagToRemove: string) => {
    setNewSubscriberTags(newSubscriberTags.filter((t) => t !== tagToRemove));
  };

  const handleCreateSubscriber = () => {
    if (!newSubscriberEmail.trim()) return;
    createSubscriberMutation.mutate({
      email: newSubscriberEmail.trim().toLowerCase(),
      tags: newSubscriberTags,
    });
  };

  const handleAddTag = () => {
    if (editingSubscriber && newTag.trim()) {
      const updatedTags = [...(editingSubscriber.tags || []), newTag.trim().toUpperCase()];
      setEditingSubscriber({ ...editingSubscriber, tags: updatedTags });
      setNewTag("");
    }
  };

  const handleRemoveTag = (tagToRemove: string) => {
    if (editingSubscriber) {
      const updatedTags = (editingSubscriber.tags || []).filter((t) => t !== tagToRemove);
      setEditingSubscriber({ ...editingSubscriber, tags: updatedTags });
    }
  };

  const handleSaveTags = () => {
    if (editingSubscriber) {
      updateTagsMutation.mutate({
        id: editingSubscriber.id,
        tags: editingSubscriber.tags || [],
      });
    }
  };

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Subscribers</h1>
          <p className="text-muted-foreground">
            Manage your email list with {data?.total?.toLocaleString() || 0} subscribers
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button onClick={() => setShowAddDialog(true)} data-testid="button-add-subscriber">
            <Plus className="h-4 w-4 mr-2" />
            Add Subscriber
          </Button>
          <Button 
            variant="destructive" 
            onClick={() => setShowFlushConfirm(true)}
            disabled={!data?.total || data.total === 0}
            data-testid="button-flush-all-subscribers"
          >
            <Trash2 className="h-4 w-4 mr-2" />
            Flush All
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4 flex-wrap">
          <CardTitle className="flex items-center gap-2">
            <Users className="h-5 w-5" />
            All Subscribers
          </CardTitle>
          <div className="flex items-center gap-2 w-full sm:w-auto">
            <div className="relative flex-1 sm:w-72">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search by email, tag, or ref..."
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
                className="pl-9"
                data-testid="input-search-subscribers"
              />
            </div>
            {search.trim() && data && data.total > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setSegmentName("");
                  setShowSaveSegmentDialog(true);
                }}
                data-testid="button-save-search-as-segment"
              >
                <Filter className="h-4 w-4 mr-1" />
                Save as Segment
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-4">
              {[1, 2, 3, 4, 5].map((i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : data?.subscribers && data.subscribers.length > 0 ? (
            <>
              <div className="rounded-md border overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Email</TableHead>
                      <TableHead>Tags</TableHead>
                      <TableHead>Refs</TableHead>
                      <TableHead>IP Address</TableHead>
                      <TableHead>Import Date</TableHead>
                      <TableHead className="w-[50px]"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.subscribers.map((subscriber) => (
                      <TableRow key={subscriber.id} data-testid={`subscriber-row-${subscriber.id}`}>
                        <TableCell className="font-mono text-sm">
                          <div className="flex items-center gap-2">
                            {subscriber.email}
                            {subscriber.tags?.includes("BCK") && (
                              <Badge variant="destructive" className="text-xs gap-1" data-testid={`badge-blacklisted-${subscriber.id}`}>
                                <ShieldBan className="h-3 w-3" />
                                Blacklisted
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1">
                            {subscriber.tags && subscriber.tags.length > 0 ? (
                              subscriber.tags.slice(0, 3).map((tag) => (
                                <Badge
                                  key={tag}
                                  variant="secondary"
                                  className="text-xs"
                                >
                                  {tag}
                                </Badge>
                              ))
                            ) : (
                              <span className="text-muted-foreground text-sm">None</span>
                            )}
                            {subscriber.tags && subscriber.tags.length > 3 && (
                              <Badge variant="outline" className="text-xs">
                                +{subscriber.tags.length - 3}
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1">
                            {subscriber.refs && subscriber.refs.length > 0 ? (
                              subscriber.refs.slice(0, 3).map((ref) => (
                                <Badge
                                  key={ref}
                                  variant="outline"
                                  className="text-xs bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/50 dark:text-blue-300 dark:border-blue-800"
                                  data-testid={`badge-ref-${subscriber.id}-${ref}`}
                                >
                                  {ref}
                                </Badge>
                              ))
                            ) : (
                              <span className="text-muted-foreground text-sm">None</span>
                            )}
                            {subscriber.refs && subscriber.refs.length > 3 && (
                              <Badge variant="outline" className="text-xs">
                                +{subscriber.refs.length - 3}
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="font-mono text-sm text-muted-foreground">
                          {subscriber.ipAddress || "N/A"}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {new Date(subscriber.importDate).toLocaleDateString()}
                        </TableCell>
                        <TableCell>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                data-testid={`button-subscriber-menu-${subscriber.id}`}
                              >
                                <MoreVertical className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem
                                onClick={() => setEditingSubscriber(subscriber)}
                                data-testid={`menu-edit-tags-${subscriber.id}`}
                              >
                                <Tag className="h-4 w-4 mr-2" />
                                Edit Tags
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                className="text-destructive"
                                onClick={() => setDeleteConfirm(subscriber)}
                                data-testid={`menu-delete-${subscriber.id}`}
                              >
                                <Trash2 className="h-4 w-4 mr-2" />
                                Delete
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              <div className="flex items-center justify-between mt-4 flex-wrap gap-4">
                <p className="text-sm text-muted-foreground">
                  Showing {((page - 1) * (data.limit || 20)) + 1} to{" "}
                  {Math.min(page * (data.limit || 20), data.total)} of {data.total.toLocaleString()} subscribers
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage(page - 1)}
                    disabled={page === 1}
                    data-testid="button-prev-page"
                  >
                    <ChevronLeft className="h-4 w-4 mr-1" />
                    Previous
                  </Button>
                  <span className="text-sm text-muted-foreground">
                    Page {page} of {data.totalPages}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage(page + 1)}
                    disabled={page >= data.totalPages}
                    data-testid="button-next-page"
                  >
                    Next
                    <ChevronRight className="h-4 w-4 ml-1" />
                  </Button>
                </div>
              </div>
            </>
          ) : (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <Users className="h-16 w-16 text-muted-foreground/50 mb-4" />
              <h3 className="text-lg font-semibold mb-2">No subscribers found</h3>
              <p className="text-muted-foreground max-w-md">
                {search
                  ? "No subscribers match your search. Try a different query."
                  : "Import your first subscribers to get started with email marketing."}
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!editingSubscriber} onOpenChange={() => setEditingSubscriber(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Tag className="h-5 w-5" />
              Edit Tags
            </DialogTitle>
            <DialogDescription>
              Manage tags for {editingSubscriber?.email}
              {editingSubscriber?.tags?.includes("BCK") && (
                <Badge variant="destructive" className="ml-2 text-xs gap-1 inline-flex" data-testid="badge-edit-blacklisted">
                  <ShieldBan className="h-3 w-3" />
                  Blacklisted
                </Badge>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-6">
            <div className="space-y-3">
              <label className="text-sm font-medium">Tags</label>
              <div className="flex flex-wrap gap-2">
                {editingSubscriber?.tags?.map((tag) => (
                  <Badge
                    key={tag}
                    variant={tag === "BCK" ? "destructive" : "secondary"}
                    className="gap-1 pr-1"
                  >
                    {tag}
                    <button
                      onClick={() => handleRemoveTag(tag)}
                      className="ml-1 rounded-full p-0.5 hover:bg-background/20"
                      data-testid={`button-remove-tag-${tag}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ))}
                {(!editingSubscriber?.tags || editingSubscriber.tags.length === 0) && (
                  <span className="text-muted-foreground text-sm">No tags</span>
                )}
              </div>
              <div className="flex gap-2">
                <Input
                  placeholder="Add tag..."
                  value={newTag}
                  onChange={(e) => setNewTag(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleAddTag()}
                  data-testid="input-new-tag"
                />
                <Button onClick={handleAddTag} size="icon" data-testid="button-add-tag">
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
            </div>
            <div className="space-y-3">
              <label className="text-sm font-medium">Refs (read-only)</label>
              <div className="flex flex-wrap gap-2">
                {editingSubscriber?.refs && editingSubscriber.refs.length > 0 ? (
                  editingSubscriber.refs.map((ref) => (
                    <Badge
                      key={ref}
                      variant="outline"
                      className="bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/50 dark:text-blue-300 dark:border-blue-800"
                      data-testid={`badge-edit-ref-${ref}`}
                    >
                      {ref}
                    </Badge>
                  ))
                ) : (
                  <span className="text-muted-foreground text-sm">No refs</span>
                )}
              </div>
              <p className="text-xs text-muted-foreground">Refs are managed via segment imports and cannot be edited manually.</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingSubscriber(null)}>
              Cancel
            </Button>
            <Button
              onClick={handleSaveTags}
              disabled={updateTagsMutation.isPending}
              data-testid="button-save-tags"
            >
              {updateTagsMutation.isPending ? "Saving..." : "Save Changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleteConfirm} onOpenChange={() => setDeleteConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Subscriber</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete {deleteConfirm?.email}? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteConfirm && deleteMutation.mutate(deleteConfirm.id)}
              disabled={deleteMutation.isPending}
              data-testid="button-confirm-delete"
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showAddDialog} onOpenChange={setShowAddDialog}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Plus className="h-5 w-5" />
              Add Subscriber
            </DialogTitle>
            <DialogDescription>
              Add a new subscriber to your email list manually.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-6">
            <div className="space-y-2">
              <label className="text-sm font-medium">Email Address</label>
              <Input
                type="email"
                placeholder="subscriber@example.com"
                value={newSubscriberEmail}
                onChange={(e) => setNewSubscriberEmail(e.target.value)}
                data-testid="input-new-subscriber-email"
              />
            </div>
            
            <div className="space-y-3">
              <label className="text-sm font-medium">Tags (optional)</label>
              <div className="flex flex-wrap gap-2 min-h-[24px]">
                {newSubscriberTags.map((tag) => (
                  <Badge key={tag} variant="secondary" className="gap-1 pr-1">
                    {tag}
                    <button
                      onClick={() => handleRemoveNewSubscriberTag(tag)}
                      className="ml-1 rounded-full p-0.5 hover:bg-background/20"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ))}
              </div>
              <div className="flex gap-2">
                <Input
                  placeholder="Add tag..."
                  value={newSubscriberTag}
                  onChange={(e) => setNewSubscriberTag(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), handleAddNewSubscriberTag())}
                  data-testid="input-new-subscriber-tag"
                />
                <Button 
                  type="button"
                  onClick={handleAddNewSubscriberTag} 
                  size="icon"
                  data-testid="button-add-new-subscriber-tag"
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAddDialog(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleCreateSubscriber}
              disabled={!newSubscriberEmail.trim() || createSubscriberMutation.isPending}
              data-testid="button-create-subscriber"
            >
              {createSubscriberMutation.isPending ? "Adding..." : "Add Subscriber"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={showFlushConfirm} onOpenChange={(open) => !flushJobId && setShowFlushConfirm(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              {flushFinishedState === "completed" ? (
                <>
                  <CheckCircle2 className="h-5 w-5 text-green-600" />
                  All Done!
                </>
              ) : flushFinishedState === "failed" ? (
                <>
                  <XCircle className="h-5 w-5 text-destructive" />
                  Deletion Failed
                </>
              ) : (
                <>
                  <AlertTriangle className="h-5 w-5 text-destructive" />
                  {flushJobId ? "Deleting Subscribers..." : "Delete All Subscribers?"}
                </>
              )}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div>
                {flushFinishedState === "completed" ? (
                  <div className="space-y-3 py-2">
                    <Progress value={100} className="h-2" data-testid="progress-flush" />
                    <div className="text-sm font-medium text-center" data-testid="text-flush-complete">
                      Successfully deleted {flushJob?.processedRows?.toLocaleString() || 0} subscribers.
                    </div>
                  </div>
                ) : flushFinishedState === "failed" ? (
                  <div className="space-y-3 py-2">
                    <div className="text-sm text-destructive" data-testid="text-flush-error">
                      {flushJob?.errorMessage || "An unexpected error occurred while deleting subscribers."}
                    </div>
                    {(flushJob?.processedRows ?? 0) > 0 && (
                      <div className="text-sm text-muted-foreground">
                        {flushJob?.processedRows?.toLocaleString()} subscribers were deleted before the error.
                      </div>
                    )}
                  </div>
                ) : flushFinishedState === "cancelled" ? (
                  <div className="space-y-3 py-2">
                    <div className="text-sm text-muted-foreground text-center">
                      Deletion cancelled. {flushJob?.processedRows?.toLocaleString() || 0} subscribers were deleted.
                    </div>
                  </div>
                ) : flushJobId ? (
                  <div className="space-y-3 py-2">
                    <div className="text-sm text-muted-foreground">
                      {flushJob?.phase === "clearing_dependencies"
                        ? "Clearing related data (sends, stats, logs)..."
                        : flushJob?.phase === "deleting_subscribers"
                        ? "Deleting subscribers in batches..."
                        : "Preparing deletion..."}
                    </div>
                    <Progress 
                      value={flushJob?.totalRows ? (flushJob.processedRows / flushJob.totalRows) * 100 : 0} 
                      className="h-2"
                      data-testid="progress-flush"
                    />
                    <div className="text-sm font-medium text-center">
                      {flushJob?.processedRows?.toLocaleString() || 0} / {flushJob?.totalRows?.toLocaleString() || data?.total?.toLocaleString() || 0} rows deleted
                    </div>
                  </div>
                ) : (
                  <span>
                    This action cannot be undone. This will permanently delete all{" "}
                    <strong>{data?.total?.toLocaleString() || 0}</strong> subscribers from your email list.
                  </span>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            {flushFinishedState === "failed" ? (
              <Button
                variant="outline"
                onClick={() => {
                  setFlushJobId(null);
                  setShowFlushConfirm(false);
                  setFlushFinishedState(null);
                  queryClient.invalidateQueries({ queryKey: ["/api/subscribers"] });
                }}
                data-testid="button-close-flush-error"
              >
                Close
              </Button>
            ) : flushFinishedState === "completed" || flushFinishedState === "cancelled" ? null : flushJobId ? (
              <Button
                variant="outline"
                onClick={() => cancelFlushMutation.mutate(flushJobId)}
                disabled={cancelFlushMutation.isPending}
                data-testid="button-cancel-flush-job"
              >
                {cancelFlushMutation.isPending ? "Cancelling..." : "Cancel Deletion"}
              </Button>
            ) : (
              <>
                <AlertDialogCancel data-testid="button-cancel-flush">Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={(e) => {
                    e.preventDefault();
                    flushAllMutation.mutate();
                  }}
                  disabled={flushAllMutation.isPending}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  data-testid="button-confirm-flush"
                >
                  {flushAllMutation.isPending ? "Starting..." : "Yes, delete all"}
                </AlertDialogAction>
              </>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={showSaveSegmentDialog} onOpenChange={setShowSaveSegmentDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Filter className="h-5 w-5" />
              Save Search as Segment
            </DialogTitle>
            <DialogDescription>
              Create a segment from your current search "{search}". This will match subscribers by email or tag containing this term.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="segment-name">Segment Name</Label>
              <Input
                id="segment-name"
                placeholder="e.g., Gmail Users"
                value={segmentName}
                onChange={(e) => setSegmentName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSaveAsSegment()}
                data-testid="input-save-segment-name"
              />
            </div>
            <div className="text-sm text-muted-foreground space-y-1">
              <p>Rules that will be created:</p>
              <div className="flex flex-wrap gap-1 items-center">
                <Badge variant="secondary" className="text-xs">Email contains "{search}"</Badge>
                <Badge variant="outline" className="text-xs">OR</Badge>
                <Badge variant="secondary" className="text-xs">Tag contains "{search.toUpperCase()}"</Badge>
                <Badge variant="outline" className="text-xs">OR</Badge>
                <Badge variant="secondary" className="text-xs">Ref is "{search.toUpperCase()}"</Badge>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowSaveSegmentDialog(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleSaveAsSegment}
              disabled={saveAsSegmentMutation.isPending || !segmentName.trim()}
              data-testid="button-confirm-save-segment"
            >
              {saveAsSegmentMutation.isPending ? "Creating..." : "Create Segment"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
