import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Flame, Play, Pause, Trash2, Plus, Calendar, TrendingUp, Activity, MoreVertical } from "lucide-react";
import type { Mta, InsertWarmupSchedule } from "@shared/schema";

interface WarmupScheduleWithMta {
  id: string;
  mtaId: string;
  name: string;
  status: string;
  startDate: string;
  currentDay: number;
  totalDays: number;
  dailyVolumeCap: number;
  maxDailyVolume: number;
  rampMultiplier: string;
  sentToday: number;
  lastResetDate: string | null;
  createdAt: string;
  mtaName: string | null;
}

export default function Warmup() {
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<WarmupScheduleWithMta | null>(null);
  const [formData, setFormData] = useState<Partial<InsertWarmupSchedule>>({
    name: "",
    mtaId: "",
    totalDays: 30,
    dailyVolumeCap: 50,
    maxDailyVolume: 100000,
    rampMultiplier: "1.5",
  });
  const { toast } = useToast();

  const { data: schedules, isLoading } = useQuery<WarmupScheduleWithMta[]>({
    queryKey: ["/api/warmup"],
  });

  const { data: mtas } = useQuery<Mta[]>({
    queryKey: ["/api/mtas"],
  });

  const createMutation = useMutation({
    mutationFn: (data: Partial<InsertWarmupSchedule>) => apiRequest("POST", "/api/warmup", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/warmup"] });
      resetForm();
      setIsCreateOpen(false);
      toast({
        title: "Warmup schedule created",
        description: "Your new IP warmup schedule has been added.",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to create warmup schedule. Please try again.",
        variant: "destructive",
      });
    },
  });

  const pauseMutation = useMutation({
    mutationFn: (id: string) => apiRequest("POST", `/api/warmup/${id}/pause`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/warmup"] });
      toast({
        title: "Schedule paused",
        description: "The warmup schedule has been paused.",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to pause schedule. Please try again.",
        variant: "destructive",
      });
    },
  });

  const resumeMutation = useMutation({
    mutationFn: (id: string) => apiRequest("POST", `/api/warmup/${id}/resume`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/warmup"] });
      toast({
        title: "Schedule resumed",
        description: "The warmup schedule has been resumed.",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to resume schedule. Please try again.",
        variant: "destructive",
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/warmup/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/warmup"] });
      setDeleteConfirm(null);
      toast({
        title: "Schedule deleted",
        description: "The warmup schedule has been removed.",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to delete schedule. Please try again.",
        variant: "destructive",
      });
    },
  });

  const resetForm = () => {
    setFormData({
      name: "",
      mtaId: "",
      totalDays: 30,
      dailyVolumeCap: 50,
      maxDailyVolume: 100000,
      rampMultiplier: "1.5",
    });
  };

  const handleSubmit = () => {
    if (!formData.name?.trim()) {
      toast({
        title: "Validation Error",
        description: "Please provide a schedule name.",
        variant: "destructive",
      });
      return;
    }
    if (!formData.mtaId) {
      toast({
        title: "Validation Error",
        description: "Please select an MTA.",
        variant: "destructive",
      });
      return;
    }
    createMutation.mutate(formData);
  };

  function calculateTodayVolumeCap(schedule: WarmupScheduleWithMta): number {
    const ramp = parseFloat(schedule.rampMultiplier);
    const volume = Math.floor(schedule.dailyVolumeCap * Math.pow(ramp, schedule.currentDay - 1));
    return Math.min(volume, schedule.maxDailyVolume);
  }

  function getStatusBadge(status: string) {
    switch (status) {
      case "active":
        return <Badge variant="default" className="gap-1" data-testid="badge-status-active"><Activity className="h-3 w-3" />Active</Badge>;
      case "paused":
        return <Badge variant="secondary" className="gap-1" data-testid="badge-status-paused"><Pause className="h-3 w-3" />Paused</Badge>;
      case "completed":
        return <Badge variant="outline" className="gap-1" data-testid="badge-status-completed"><TrendingUp className="h-3 w-3" />Completed</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  }

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight" data-testid="text-page-title">IP Warmup</h1>
          <p className="text-muted-foreground">
            Manage IP warmup schedules for your sending servers
          </p>
        </div>
        <Dialog open={isCreateOpen} onOpenChange={(open) => { setIsCreateOpen(open); if (!open) resetForm(); }}>
          <DialogTrigger asChild>
            <Button data-testid="button-add-warmup">
              <Plus className="h-4 w-4 mr-2" />
              Add Schedule
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Create Warmup Schedule</DialogTitle>
              <DialogDescription>
                Set up a new IP warmup schedule for gradual volume increase
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="warmup-name">Name *</Label>
                <Input
                  id="warmup-name"
                  placeholder="e.g., Primary IP Warmup"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  data-testid="input-warmup-name"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="warmup-mta">MTA *</Label>
                <Select
                  value={formData.mtaId}
                  onValueChange={(value) => setFormData({ ...formData, mtaId: value })}
                >
                  <SelectTrigger data-testid="select-warmup-mta">
                    <SelectValue placeholder="Select an MTA" />
                  </SelectTrigger>
                  <SelectContent>
                    {mtas?.map((mta) => (
                      <SelectItem key={mta.id} value={mta.id} data-testid={`select-mta-option-${mta.id}`}>
                        {mta.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="warmup-total-days">Total Days</Label>
                  <Input
                    id="warmup-total-days"
                    type="number"
                    min="1"
                    max="90"
                    value={formData.totalDays}
                    onChange={(e) => setFormData({ ...formData, totalDays: parseInt(e.target.value) || 30 })}
                    data-testid="input-warmup-total-days"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="warmup-initial-volume">Initial Daily Volume Cap</Label>
                  <Input
                    id="warmup-initial-volume"
                    type="number"
                    min="1"
                    value={formData.dailyVolumeCap}
                    onChange={(e) => setFormData({ ...formData, dailyVolumeCap: parseInt(e.target.value) || 50 })}
                    data-testid="input-warmup-daily-volume-cap"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="warmup-max-volume">Max Daily Volume</Label>
                  <Input
                    id="warmup-max-volume"
                    type="number"
                    min="100"
                    value={formData.maxDailyVolume}
                    onChange={(e) => setFormData({ ...formData, maxDailyVolume: parseInt(e.target.value) || 100000 })}
                    data-testid="input-warmup-max-daily-volume"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="warmup-ramp">Ramp Multiplier</Label>
                  <Input
                    id="warmup-ramp"
                    placeholder="1.5"
                    value={formData.rampMultiplier}
                    onChange={(e) => setFormData({ ...formData, rampMultiplier: e.target.value })}
                    data-testid="input-warmup-ramp-multiplier"
                  />
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => { setIsCreateOpen(false); resetForm(); }}>
                Cancel
              </Button>
              <Button
                onClick={handleSubmit}
                disabled={createMutation.isPending}
                data-testid="button-submit-warmup"
              >
                {createMutation.isPending ? "Creating..." : "Create Schedule"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-56" data-testid={`skeleton-warmup-${i}`} />
          ))}
        </div>
      ) : schedules && schedules.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {schedules.map((schedule) => {
            const todayCap = calculateTodayVolumeCap(schedule);
            const progressPercent = schedule.totalDays > 0 ? Math.round((schedule.currentDay / schedule.totalDays) * 100) : 0;

            return (
              <Card key={schedule.id} data-testid={`warmup-card-${schedule.id}`}>
                <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
                  <div className="flex items-start gap-3">
                    <div className="p-2 rounded-md bg-muted">
                      <Flame className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <CardTitle className="text-lg truncate" data-testid={`text-warmup-name-${schedule.id}`}>{schedule.name}</CardTitle>
                        {getStatusBadge(schedule.status)}
                      </div>
                      <CardDescription className="text-xs mt-1" data-testid={`text-warmup-mta-${schedule.id}`}>
                        {schedule.mtaName || "Unknown MTA"}
                      </CardDescription>
                    </div>
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" data-testid={`button-warmup-actions-${schedule.id}`}>
                        <MoreVertical className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {schedule.status === "active" && (
                        <DropdownMenuItem
                          onClick={() => pauseMutation.mutate(schedule.id)}
                          disabled={pauseMutation.isPending}
                          data-testid={`button-pause-warmup-${schedule.id}`}
                        >
                          <Pause className="h-4 w-4 mr-2" />
                          Pause
                        </DropdownMenuItem>
                      )}
                      {schedule.status === "paused" && (
                        <DropdownMenuItem
                          onClick={() => resumeMutation.mutate(schedule.id)}
                          disabled={resumeMutation.isPending}
                          data-testid={`button-resume-warmup-${schedule.id}`}
                        >
                          <Play className="h-4 w-4 mr-2" />
                          Resume
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem
                        onClick={() => setDeleteConfirm(schedule)}
                        className="text-destructive focus:text-destructive"
                        data-testid={`button-delete-warmup-${schedule.id}`}
                      >
                        <Trash2 className="h-4 w-4 mr-2" />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-center justify-between text-sm">
                    <div className="flex items-center gap-1.5 text-muted-foreground">
                      <Calendar className="h-3.5 w-3.5" />
                      <span data-testid={`text-warmup-day-${schedule.id}`}>Day {schedule.currentDay} / {schedule.totalDays}</span>
                    </div>
                    <span className="text-xs text-muted-foreground" data-testid={`text-warmup-progress-pct-${schedule.id}`}>{progressPercent}%</span>
                  </div>
                  <Progress value={progressPercent} className="h-2" data-testid={`progress-warmup-${schedule.id}`} />
                  <div className="flex items-center justify-between text-sm">
                    <div className="flex items-center gap-1.5 text-muted-foreground">
                      <TrendingUp className="h-3.5 w-3.5" />
                      <span>Sent today</span>
                    </div>
                    <span className="font-medium" data-testid={`text-warmup-sent-${schedule.id}`}>
                      {schedule.sentToday.toLocaleString()} / {todayCap.toLocaleString()}
                    </span>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      ) : (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <Flame className="h-12 w-12 text-muted-foreground/50 mb-4" />
            <h3 className="text-lg font-medium mb-1">No warmup schedules</h3>
            <p className="text-sm text-muted-foreground mb-4">
              Create a warmup schedule to gradually increase your sending volume
            </p>
            <Button onClick={() => setIsCreateOpen(true)} data-testid="button-add-warmup-empty">
              <Plus className="h-4 w-4 mr-2" />
              Add Schedule
            </Button>
          </CardContent>
        </Card>
      )}

      <AlertDialog open={!!deleteConfirm} onOpenChange={(open) => { if (!open) setDeleteConfirm(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Warmup Schedule</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{deleteConfirm?.name}"? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteConfirm && deleteMutation.mutate(deleteConfirm.id)}
              className="bg-destructive text-destructive-foreground"
              disabled={deleteMutation.isPending}
              data-testid="button-confirm-delete"
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
