import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
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
import { 
  Search, 
  MoreVertical, 
  Trash2, 
  Edit2, 
  ChevronLeft, 
  ChevronRight,
  Users,
  Tag,
  X,
  Plus,
  AlertTriangle,
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
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [editingSubscriber, setEditingSubscriber] = useState<Subscriber | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<Subscriber | null>(null);
  const [newPositiveTag, setNewPositiveTag] = useState("");
  const [newNegativeTag, setNewNegativeTag] = useState("");
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [newSubscriberEmail, setNewSubscriberEmail] = useState("");
  const [newSubscriberPositiveTags, setNewSubscriberPositiveTags] = useState<string[]>([]);
  const [newSubscriberNegativeTags, setNewSubscriberNegativeTags] = useState<string[]>([]);
  const [newSubscriberPositiveTag, setNewSubscriberPositiveTag] = useState("");
  const [newSubscriberNegativeTag, setNewSubscriberNegativeTag] = useState("");
  const [showFlushConfirm, setShowFlushConfirm] = useState(false);
  const [flushJobId, setFlushJobId] = useState<string | null>(null);
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
    mutationFn: ({ id, positiveTags, negativeTags }: { id: string; positiveTags: string[]; negativeTags: string[] }) =>
      apiRequest("PATCH", `/api/subscribers/${id}`, { positiveTags, negativeTags }),
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
    mutationFn: (data: { email: string; positiveTags: string[]; negativeTags: string[] }) =>
      apiRequest("POST", "/api/subscribers", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/subscribers"] });
      setShowAddDialog(false);
      setNewSubscriberEmail("");
      setNewSubscriberPositiveTags([]);
      setNewSubscriberNegativeTags([]);
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
    refetchInterval: flushJobId ? 1000 : false,
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

  useEffect(() => {
    if (flushJob?.status === "completed") {
      setFlushJobId(null);
      setShowFlushConfirm(false);
      setPage(1);
      queryClient.invalidateQueries({ queryKey: ["/api/subscribers"] });
      toast({
        title: "All subscribers deleted",
        description: `Successfully deleted ${flushJob.processedRows.toLocaleString()} subscribers.`,
      });
    } else if (flushJob?.status === "failed") {
      setFlushJobId(null);
      setShowFlushConfirm(false);
      toast({
        title: "Error",
        description: flushJob.errorMessage || "Failed to delete subscribers.",
        variant: "destructive",
      });
    } else if (flushJob?.status === "cancelled") {
      setFlushJobId(null);
      setShowFlushConfirm(false);
      queryClient.invalidateQueries({ queryKey: ["/api/subscribers"] });
      toast({
        title: "Deletion cancelled",
        description: `Stopped after deleting ${flushJob.processedRows.toLocaleString()} subscribers.`,
      });
    }
  }, [flushJob?.status]);

  const flushAllMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("DELETE", "/api/subscribers");
      return res.json() as Promise<{ jobId: string | null; totalRows: number; message: string }>;
    },
    onSuccess: (response) => {
      if (response.jobId) {
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

  const handleAddNewSubscriberPositiveTag = () => {
    if (newSubscriberPositiveTag.trim()) {
      setNewSubscriberPositiveTags([...newSubscriberPositiveTags, newSubscriberPositiveTag.trim().toUpperCase()]);
      setNewSubscriberPositiveTag("");
    }
  };

  const handleAddNewSubscriberNegativeTag = () => {
    if (newSubscriberNegativeTag.trim()) {
      setNewSubscriberNegativeTags([...newSubscriberNegativeTags, newSubscriberNegativeTag.trim().toUpperCase()]);
      setNewSubscriberNegativeTag("");
    }
  };

  const handleRemoveNewSubscriberPositiveTag = (tagToRemove: string) => {
    setNewSubscriberPositiveTags(newSubscriberPositiveTags.filter((t) => t !== tagToRemove));
  };

  const handleRemoveNewSubscriberNegativeTag = (tagToRemove: string) => {
    setNewSubscriberNegativeTags(newSubscriberNegativeTags.filter((t) => t !== tagToRemove));
  };

  const handleCreateSubscriber = () => {
    if (!newSubscriberEmail.trim()) return;
    createSubscriberMutation.mutate({
      email: newSubscriberEmail.trim().toLowerCase(),
      positiveTags: newSubscriberPositiveTags,
      negativeTags: newSubscriberNegativeTags,
    });
  };

  const handleAddPositiveTag = () => {
    if (editingSubscriber && newPositiveTag.trim()) {
      const updatedTags = [...(editingSubscriber.positiveTags || []), newPositiveTag.trim().toUpperCase()];
      setEditingSubscriber({ ...editingSubscriber, positiveTags: updatedTags });
      setNewPositiveTag("");
    }
  };

  const handleAddNegativeTag = () => {
    if (editingSubscriber && newNegativeTag.trim()) {
      const updatedTags = [...(editingSubscriber.negativeTags || []), newNegativeTag.trim().toUpperCase()];
      setEditingSubscriber({ ...editingSubscriber, negativeTags: updatedTags });
      setNewNegativeTag("");
    }
  };

  const handleRemovePositiveTag = (tagToRemove: string) => {
    if (editingSubscriber) {
      const updatedTags = (editingSubscriber.positiveTags || []).filter((t) => t !== tagToRemove);
      setEditingSubscriber({ ...editingSubscriber, positiveTags: updatedTags });
    }
  };

  const handleRemoveNegativeTag = (tagToRemove: string) => {
    if (editingSubscriber) {
      const updatedTags = (editingSubscriber.negativeTags || []).filter((t) => t !== tagToRemove);
      setEditingSubscriber({ ...editingSubscriber, negativeTags: updatedTags });
    }
  };

  const handleSaveTags = () => {
    if (editingSubscriber) {
      updateTagsMutation.mutate({
        id: editingSubscriber.id,
        positiveTags: editingSubscriber.positiveTags || [],
        negativeTags: editingSubscriber.negativeTags || [],
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
          <div className="relative w-full sm:w-72">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by email or tag..."
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              className="pl-9"
              data-testid="input-search-subscribers"
            />
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
                      <TableHead>Positive Tags</TableHead>
                      <TableHead>Negative Tags</TableHead>
                      <TableHead>IP Address</TableHead>
                      <TableHead>Import Date</TableHead>
                      <TableHead className="w-[50px]"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.subscribers.map((subscriber) => (
                      <TableRow key={subscriber.id} data-testid={`subscriber-row-${subscriber.id}`}>
                        <TableCell className="font-mono text-sm">
                          {subscriber.email}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1">
                            {subscriber.positiveTags && subscriber.positiveTags.length > 0 ? (
                              subscriber.positiveTags.slice(0, 3).map((tag) => (
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
                            {subscriber.positiveTags && subscriber.positiveTags.length > 3 && (
                              <Badge variant="outline" className="text-xs">
                                +{subscriber.positiveTags.length - 3}
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1">
                            {subscriber.negativeTags && subscriber.negativeTags.length > 0 ? (
                              subscriber.negativeTags.slice(0, 3).map((tag) => (
                                <Badge
                                  key={tag}
                                  variant="destructive"
                                  className="text-xs"
                                >
                                  {tag}
                                </Badge>
                              ))
                            ) : (
                              <span className="text-muted-foreground text-sm">None</span>
                            )}
                            {subscriber.negativeTags && subscriber.negativeTags.length > 3 && (
                              <Badge variant="outline" className="text-xs">
                                +{subscriber.negativeTags.length - 3}
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
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-6">
            <div className="space-y-3">
              <label className="text-sm font-medium">Positive Tags</label>
              <div className="flex flex-wrap gap-2">
                {editingSubscriber?.positiveTags?.map((tag) => (
                  <Badge
                    key={tag}
                    variant="secondary"
                    className="gap-1 pr-1"
                  >
                    {tag}
                    <button
                      onClick={() => handleRemovePositiveTag(tag)}
                      className="ml-1 rounded-full p-0.5 hover:bg-background/20"
                      data-testid={`button-remove-positive-tag-${tag}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ))}
                {(!editingSubscriber?.positiveTags || editingSubscriber.positiveTags.length === 0) && (
                  <span className="text-muted-foreground text-sm">No positive tags</span>
                )}
              </div>
              <div className="flex gap-2">
                <Input
                  placeholder="Add positive tag..."
                  value={newPositiveTag}
                  onChange={(e) => setNewPositiveTag(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleAddPositiveTag()}
                  data-testid="input-new-positive-tag"
                />
                <Button onClick={handleAddPositiveTag} size="icon" data-testid="button-add-positive-tag">
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
            </div>
            
            <div className="space-y-3">
              <label className="text-sm font-medium">Negative Tags</label>
              <div className="flex flex-wrap gap-2">
                {editingSubscriber?.negativeTags?.map((tag) => (
                  <Badge
                    key={tag}
                    variant="destructive"
                    className="gap-1 pr-1"
                  >
                    {tag}
                    <button
                      onClick={() => handleRemoveNegativeTag(tag)}
                      className="ml-1 rounded-full p-0.5 hover:bg-background/20"
                      data-testid={`button-remove-negative-tag-${tag}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ))}
                {(!editingSubscriber?.negativeTags || editingSubscriber.negativeTags.length === 0) && (
                  <span className="text-muted-foreground text-sm">No negative tags</span>
                )}
              </div>
              <div className="flex gap-2">
                <Input
                  placeholder="Add negative tag..."
                  value={newNegativeTag}
                  onChange={(e) => setNewNegativeTag(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleAddNegativeTag()}
                  data-testid="input-new-negative-tag"
                />
                <Button onClick={handleAddNegativeTag} size="icon" data-testid="button-add-negative-tag">
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
            </div>
            
            <p className="text-xs text-muted-foreground">
              Positive tags are used for inclusion targeting. Negative tags exclude subscribers from campaigns.
            </p>
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
              <label className="text-sm font-medium">Positive Tags (optional)</label>
              <div className="flex flex-wrap gap-2 min-h-[24px]">
                {newSubscriberPositiveTags.map((tag) => (
                  <Badge key={tag} variant="secondary" className="gap-1 pr-1">
                    {tag}
                    <button
                      onClick={() => handleRemoveNewSubscriberPositiveTag(tag)}
                      className="ml-1 rounded-full p-0.5 hover:bg-background/20"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ))}
              </div>
              <div className="flex gap-2">
                <Input
                  placeholder="Add positive tag..."
                  value={newSubscriberPositiveTag}
                  onChange={(e) => setNewSubscriberPositiveTag(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), handleAddNewSubscriberPositiveTag())}
                  data-testid="input-new-subscriber-positive-tag"
                />
                <Button 
                  type="button"
                  onClick={handleAddNewSubscriberPositiveTag} 
                  size="icon"
                  data-testid="button-add-new-subscriber-positive-tag"
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
            </div>
            
            <div className="space-y-3">
              <label className="text-sm font-medium">Negative Tags (optional)</label>
              <div className="flex flex-wrap gap-2 min-h-[24px]">
                {newSubscriberNegativeTags.map((tag) => (
                  <Badge key={tag} variant="destructive" className="gap-1 pr-1">
                    {tag}
                    <button
                      onClick={() => handleRemoveNewSubscriberNegativeTag(tag)}
                      className="ml-1 rounded-full p-0.5 hover:bg-background/20"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ))}
              </div>
              <div className="flex gap-2">
                <Input
                  placeholder="Add negative tag..."
                  value={newSubscriberNegativeTag}
                  onChange={(e) => setNewSubscriberNegativeTag(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), handleAddNewSubscriberNegativeTag())}
                  data-testid="input-new-subscriber-negative-tag"
                />
                <Button 
                  type="button"
                  onClick={handleAddNewSubscriberNegativeTag} 
                  size="icon"
                  data-testid="button-add-new-subscriber-negative-tag"
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
              <AlertTriangle className="h-5 w-5 text-destructive" />
              {flushJobId ? "Deleting Subscribers..." : "Delete All Subscribers?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {flushJobId ? (
                <div className="space-y-3 py-2">
                  <div className="text-sm text-muted-foreground">
                    Deleting subscribers in batches...
                  </div>
                  <Progress 
                    value={flushJob?.totalRows ? (flushJob.processedRows / flushJob.totalRows) * 100 : 0} 
                    className="h-2"
                    data-testid="progress-flush"
                  />
                  <div className="text-sm font-medium text-center">
                    {flushJob?.processedRows?.toLocaleString() || 0} / {flushJob?.totalRows?.toLocaleString() || data?.total?.toLocaleString() || 0} subscribers deleted
                  </div>
                </div>
              ) : (
                <>
                  This action cannot be undone. This will permanently delete all{" "}
                  <strong>{data?.total?.toLocaleString() || 0}</strong> subscribers from your email list.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            {flushJobId ? (
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
    </div>
  );
}
