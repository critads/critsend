import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Eye, EyeOff } from "lucide-react";
import type { InsertMta } from "@shared/schema";

export type MtaFormData = Partial<InsertMta> & { protocol?: string };

interface MtaFormProps {
  formData: MtaFormData;
  onChange: (data: MtaFormData) => void;
  showPassword: boolean;
  setShowPassword: (v: boolean) => void;
}

const STANDARD_PORTS: Record<string, number> = {
  SSL: 465,
  TLS: 465,
  STARTTLS: 587,
  NONE: 25,
};

export function MtaForm({ formData, onChange, showPassword, setShowPassword }: MtaFormProps) {
  const handleProtocolChange = (protocol: string) => {
    onChange({ ...formData, protocol });
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">

        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="mta-name">Server Name *</Label>
          <Input
            id="mta-name"
            placeholder="e.g., Primary SMTP"
            value={formData.name ?? ""}
            onChange={(e) => onChange({ ...formData, name: e.target.value })}
            data-testid="input-mta-name"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="mta-from-name">From Name *</Label>
          <Input
            id="mta-from-name"
            placeholder="e.g., My Company"
            value={formData.fromName ?? ""}
            onChange={(e) => onChange({ ...formData, fromName: e.target.value })}
            data-testid="input-mta-from-name"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="mta-from-email">From Email *</Label>
          <Input
            id="mta-from-email"
            type="email"
            placeholder="hello@company.com"
            value={formData.fromEmail ?? ""}
            onChange={(e) => onChange({ ...formData, fromEmail: e.target.value })}
            data-testid="input-mta-from-email"
          />
        </div>

        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="mta-hostname">Hostname</Label>
          <Input
            id="mta-hostname"
            placeholder="smtp.example.com"
            value={formData.hostname ?? ""}
            onChange={(e) => onChange({ ...formData, hostname: e.target.value })}
            className="font-mono text-sm"
            data-testid="input-mta-hostname"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="mta-protocol">Protocol</Label>
          <Select
            value={formData.protocol ?? "STARTTLS"}
            onValueChange={handleProtocolChange}
          >
            <SelectTrigger id="mta-protocol" data-testid="select-mta-protocol">
              <SelectValue placeholder="Select protocol" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="STARTTLS">
                <div className="flex flex-col">
                  <span>STARTTLS</span>
                  <span className="text-xs text-muted-foreground">Upgrades to TLS after greeting · port 587</span>
                </div>
              </SelectItem>
              <SelectItem value="SSL">
                <div className="flex flex-col">
                  <span>SSL</span>
                  <span className="text-xs text-muted-foreground">Implicit TLS from start · port 465</span>
                </div>
              </SelectItem>
              <SelectItem value="TLS">
                <div className="flex flex-col">
                  <span>TLS</span>
                  <span className="text-xs text-muted-foreground">Implicit TLS (alt. label) · port 465</span>
                </div>
              </SelectItem>
              <SelectItem value="NONE">
                <div className="flex flex-col">
                  <span>NONE</span>
                  <span className="text-xs text-muted-foreground">No encryption · port 25</span>
                </div>
              </SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Protocol selection does not change your port.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="mta-port">
            Port{" "}
            {formData.protocol && STANDARD_PORTS[formData.protocol] && (
              <span className="text-xs font-normal text-muted-foreground ml-1">
                (standard for {formData.protocol}: {STANDARD_PORTS[formData.protocol]})
              </span>
            )}
          </Label>
          <Input
            id="mta-port"
            type="number"
            placeholder={String(STANDARD_PORTS[formData.protocol ?? "STARTTLS"] ?? 587)}
            value={formData.port ?? ""}
            onChange={(e) => onChange({ ...formData, port: parseInt(e.target.value) || 587 })}
            data-testid="input-mta-port"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="mta-username">SMTP User</Label>
          <Input
            id="mta-username"
            placeholder="smtp_user"
            value={formData.username ?? ""}
            onChange={(e) => onChange({ ...formData, username: e.target.value })}
            className="font-mono text-sm"
            data-testid="input-mta-username"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="mta-password">Password</Label>
          <div className="relative">
            <Input
              id="mta-password"
              type={showPassword ? "text" : "password"}
              placeholder="••••••••"
              value={formData.password ?? ""}
              onChange={(e) => onChange({ ...formData, password: e.target.value })}
              className="pr-10 font-mono text-sm"
              data-testid="input-mta-password"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute right-0 top-0 h-full"
              onClick={() => setShowPassword(!showPassword)}
            >
              {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </Button>
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="mta-tracking-domain">Click Tracking Domain</Label>
          <Input
            id="mta-tracking-domain"
            placeholder="track.example.com"
            value={formData.trackingDomain ?? ""}
            onChange={(e) => onChange({ ...formData, trackingDomain: e.target.value })}
            className="font-mono text-sm"
            data-testid="input-mta-tracking-domain"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="mta-open-tracking">Open Tracking Domain</Label>
          <Input
            id="mta-open-tracking"
            placeholder="open.example.com"
            value={formData.openTrackingDomain ?? ""}
            onChange={(e) => onChange({ ...formData, openTrackingDomain: e.target.value })}
            className="font-mono text-sm"
            data-testid="input-mta-open-tracking"
          />
        </div>

        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="mta-image-hosting">Image Hosting Domain</Label>
          <Input
            id="mta-image-hosting"
            placeholder="https://images.example.com"
            value={formData.imageHostingDomain ?? ""}
            onChange={(e) => onChange({ ...formData, imageHostingDomain: e.target.value })}
            className="font-mono text-sm"
            data-testid="input-mta-image-hosting"
          />
          <p className="text-xs text-muted-foreground">
            Domain to use for locally hosted email images (e.g., https://images.yourdomain.com)
          </p>
        </div>

        <div className="flex items-center justify-between sm:col-span-2 p-3 rounded-md bg-muted/50">
          <div>
            <Label htmlFor="mta-active">Active</Label>
            <p className="text-sm text-muted-foreground">Enable this server for sending</p>
          </div>
          <Switch
            id="mta-active"
            checked={formData.isActive ?? true}
            onCheckedChange={(checked) => onChange({ ...formData, isActive: checked })}
            data-testid="switch-mta-active"
          />
        </div>

        <div className="sm:col-span-2 space-y-3 p-3 rounded-md bg-muted/50">
          <div>
            <Label>Mode</Label>
            <p className="text-sm text-muted-foreground">
              Choose how this MTA handles email delivery
            </p>
          </div>
          <RadioGroup
            value={formData.mode ?? "real"}
            onValueChange={(value) => onChange({ ...formData, mode: value })}
            className="flex flex-col gap-3"
            data-testid="radio-mta-mode"
          >
            <div className="flex items-center space-x-3">
              <RadioGroupItem value="real" id="mode-real" data-testid="radio-mode-real" />
              <Label htmlFor="mode-real" className="font-normal cursor-pointer">
                <span className="font-medium">Real</span>
                <span className="text-muted-foreground ml-1">- Send emails via SMTP server</span>
              </Label>
            </div>
            <div className="flex items-center space-x-3">
              <RadioGroupItem value="nullsink" id="mode-nullsink" data-testid="radio-mode-nullsink" />
              <Label htmlFor="mode-nullsink" className="font-normal cursor-pointer">
                <span className="font-medium">Nullsink (Test Mode)</span>
                <span className="text-muted-foreground ml-1">- Capture emails without sending</span>
              </Label>
            </div>
          </RadioGroup>
        </div>

        {formData.mode === "nullsink" && (
          <>
            <div className="space-y-2">
              <Label htmlFor="mta-latency">Simulated Latency (ms)</Label>
              <Input
                id="mta-latency"
                type="number"
                min="0"
                placeholder="0"
                value={formData.simulatedLatencyMs ?? 0}
                onChange={(e) => onChange({ ...formData, simulatedLatencyMs: parseInt(e.target.value) || 0 })}
                data-testid="input-mta-latency"
              />
              <p className="text-xs text-muted-foreground">
                Delay in milliseconds to simulate network latency
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="mta-failure-rate">Failure Rate (%)</Label>
              <Input
                id="mta-failure-rate"
                type="number"
                min="0"
                max="100"
                placeholder="0"
                value={formData.failureRate ?? 0}
                onChange={(e) => {
                  const value = parseInt(e.target.value) || 0;
                  onChange({ ...formData, failureRate: Math.min(100, Math.max(0, value)) });
                }}
                data-testid="input-mta-failure-rate"
              />
              <p className="text-xs text-muted-foreground">
                Percentage of emails that will simulate delivery failure (0-100)
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
