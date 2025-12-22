import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
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
  const [newTag, setNewTag] = useState("");
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [newSubscriberEmail, setNewSubscriberEmail] = useState("");
  const [newSubscriberTags, setNewSubscriberTags] = useState<string[]>([]);
  const [newSubscriberTag, setNewSubscriberTag] = useState("");
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
        <Button onClick={() => setShowAddDialog(true)} data-testid="button-add-subscriber">
          <Plus className="h-4 w-4 mr-2" />
          Add Subscriber
        </Button>
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
                      <TableHead>Tags</TableHead>
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
                            {subscriber.tags && subscriber.tags.length > 0 ? (
                              subscriber.tags.slice(0, 3).map((tag) => (
                                <Badge
                                  key={tag}
                                  variant={tag === "BCK" ? "destructive" : "secondary"}
                                  className="text-xs"
                                >
                                  {tag}
                                </Badge>
                              ))
                            ) : (
                              <span className="text-muted-foreground text-sm">No tags</span>
                            )}
                            {subscriber.tags && subscriber.tags.length > 3 && (
                              <Badge variant="outline" className="text-xs">
                                +{subscriber.tags.length - 3}
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
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Tag className="h-5 w-5" />
              Edit Tags
            </DialogTitle>
            <DialogDescription>
              Manage tags for {editingSubscriber?.email}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
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
                placeholder="Add new tag..."
                value={newTag}
                onChange={(e) => setNewTag(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAddTag()}
                data-testid="input-new-tag"
              />
              <Button onClick={handleAddTag} size="icon" data-testid="button-add-tag">
                <Plus className="h-4 w-4" />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Note: Tag "BCK" will exclude subscriber from all campaigns
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
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Plus className="h-5 w-5" />
              Add Subscriber
            </DialogTitle>
            <DialogDescription>
              Add a new subscriber to your email list manually.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
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
            <div className="space-y-2">
              <label className="text-sm font-medium">Tags (optional)</label>
              <div className="flex flex-wrap gap-2 mb-2">
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
    </div>
  );
}
