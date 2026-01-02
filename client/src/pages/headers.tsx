import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { FileCode, Plus, Trash2, Edit2, AlertCircle, Link2 } from "lucide-react";
import type { EmailHeader, InsertEmailHeader } from "@shared/schema";

export default function Headers() {
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingHeader, setEditingHeader] = useState<EmailHeader | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<EmailHeader | null>(null);
  const [formData, setFormData] = useState<Partial<InsertEmailHeader>>({
    name: "",
    value: "",
    isDefault: false,
  });
  const { toast } = useToast();

  const { data: headers, isLoading } = useQuery<EmailHeader[]>({
    queryKey: ["/api/headers"],
  });

  const createMutation = useMutation({
    mutationFn: (data: Partial<InsertEmailHeader>) =>
      apiRequest("POST", "/api/headers", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/headers"] });
      resetForm();
      setIsCreateOpen(false);
      toast({
        title: "Header created",
        description: "The email header has been added.",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to create header. Please try again.",
        variant: "destructive",
      });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<InsertEmailHeader> }) =>
      apiRequest("PATCH", `/api/headers/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/headers"] });
      setEditingHeader(null);
      resetForm();
      toast({
        title: "Header updated",
        description: "The email header has been updated.",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to update header. Please try again.",
        variant: "destructive",
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/headers/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/headers"] });
      setDeleteConfirm(null);
      toast({
        title: "Header deleted",
        description: "The email header has been removed.",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to delete header. Please try again.",
        variant: "destructive",
      });
    },
  });

  const resetForm = () => {
    setFormData({ name: "", value: "", isDefault: false });
  };

  const handleEditClick = (header: EmailHeader) => {
    setEditingHeader(header);
    setFormData({
      name: header.name,
      value: header.value,
      isDefault: header.isDefault,
    });
  };

  const handleSubmit = () => {
    if (!formData.name?.trim() || !formData.value?.trim()) {
      toast({
        title: "Validation Error",
        description: "Please fill in all required fields.",
        variant: "destructive",
      });
      return;
    }

    const headerName = formData.name?.startsWith("X-") ? formData.name : `X-${formData.name}`;
    const data = { ...formData, name: headerName };

    if (editingHeader) {
      updateMutation.mutate({ id: editingHeader.id, data });
    } else {
      createMutation.mutate(data);
    }
  };

  const HeaderForm = () => (
    <div className="space-y-6">
      <div className="space-y-2">
        <Label htmlFor="header-name">Header Name *</Label>
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground font-mono">X-</span>
          <Input
            id="header-name"
            placeholder="Custom-Header"
            value={formData.name?.replace(/^X-/, "") || ""}
            onChange={(e) => setFormData({ ...formData, name: e.target.value })}
            className="font-mono"
            data-testid="input-header-name"
          />
        </div>
        <p className="text-xs text-muted-foreground">
          Custom email headers should start with X-
        </p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="header-value">Header Value *</Label>
        <div className="flex items-center gap-2">
          <Input
            id="header-value"
            placeholder="header-value"
            value={formData.value}
            onChange={(e) => setFormData({ ...formData, value: e.target.value })}
            className="font-mono flex-1"
            data-testid="input-header-value"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setFormData({ ...formData, value: "{UNSUBSCRIBE}" })}
            data-testid="button-insert-unsubscribe"
          >
            <Link2 className="h-4 w-4 mr-1.5" />
            Unsubscribe
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Use <code className="px-1 py-0.5 rounded bg-muted font-mono">{"{UNSUBSCRIBE}"}</code> to auto-insert the campaign unsubscribe link
        </p>
      </div>
      <div className="flex items-center justify-between p-3 rounded-md bg-muted/50">
        <div>
          <Label htmlFor="header-default">Default Header</Label>
          <p className="text-sm text-muted-foreground">
            Include in all campaigns by default
          </p>
        </div>
        <Switch
          id="header-default"
          checked={formData.isDefault}
          onCheckedChange={(checked) => setFormData({ ...formData, isDefault: checked })}
          data-testid="switch-header-default"
        />
      </div>
    </div>
  );

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Email Headers</h1>
          <p className="text-muted-foreground">
            Manage custom X- headers for your email campaigns
          </p>
        </div>
        <Dialog open={isCreateOpen} onOpenChange={(open) => { setIsCreateOpen(open); if (!open) resetForm(); }}>
          <DialogTrigger asChild>
            <Button data-testid="button-add-header">
              <Plus className="h-4 w-4 mr-2" />
              Add Header
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add Email Header</DialogTitle>
              <DialogDescription>
                Create a custom X- header for your email campaigns
              </DialogDescription>
            </DialogHeader>
            <HeaderForm />
            <DialogFooter>
              <Button variant="outline" onClick={() => { setIsCreateOpen(false); resetForm(); }}>
                Cancel
              </Button>
              <Button
                onClick={handleSubmit}
                disabled={createMutation.isPending}
                data-testid="button-submit-header"
              >
                {createMutation.isPending ? "Adding..." : "Add Header"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <div className="rounded-md bg-muted/50 p-4 flex items-start gap-3">
        <AlertCircle className="h-5 w-5 text-muted-foreground mt-0.5" />
        <div>
          <p className="font-medium text-sm">About Email Headers</p>
          <p className="text-sm text-muted-foreground">
            Custom X- headers can be used for tracking, authentication, or passing metadata. 
            Headers marked as "Default" will be automatically included in all outgoing campaigns.
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileCode className="h-5 w-5" />
            Custom Headers
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-4">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-16" />
              ))}
            </div>
          ) : headers && headers.length > 0 ? (
            <div className="rounded-md border overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Header Name</TableHead>
                    <TableHead>Value</TableHead>
                    <TableHead>Default</TableHead>
                    <TableHead className="w-[100px]"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {headers.map((header) => (
                    <TableRow key={header.id} data-testid={`header-row-${header.id}`}>
                      <TableCell className="font-mono text-sm">{header.name}</TableCell>
                      <TableCell className="font-mono text-sm text-muted-foreground">
                        {header.value}
                      </TableCell>
                      <TableCell>
                        {header.isDefault ? (
                          <Badge variant="default">Default</Badge>
                        ) : (
                          <Badge variant="outline">Optional</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleEditClick(header)}
                            data-testid={`button-edit-header-${header.id}`}
                          >
                            <Edit2 className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setDeleteConfirm(header)}
                            data-testid={`button-delete-header-${header.id}`}
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <div className="text-center py-16 text-muted-foreground">
              <FileCode className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>No custom headers defined</p>
              <p className="text-sm mt-1">Add headers to include in your campaigns</p>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!editingHeader} onOpenChange={() => { setEditingHeader(null); resetForm(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Email Header</DialogTitle>
            <DialogDescription>
              Update this custom X- header
            </DialogDescription>
          </DialogHeader>
          <HeaderForm />
          <DialogFooter>
            <Button variant="outline" onClick={() => { setEditingHeader(null); resetForm(); }}>
              Cancel
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={updateMutation.isPending}
              data-testid="button-update-header"
            >
              {updateMutation.isPending ? "Saving..." : "Save Changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleteConfirm} onOpenChange={() => setDeleteConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Header</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete the header "{deleteConfirm?.name}"?
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
              data-testid="button-confirm-delete-header"
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
