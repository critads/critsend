import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, Tag, Mail, Calendar, Globe, Layers, X } from "lucide-react";
import type { SegmentCondition, SegmentGroup, SegmentRulesV2 } from "@shared/schema";
import { fieldOperatorsV2, operatorLabelsV2, migrateRulesV1toV2 } from "@shared/schema";

export const fieldLabels: Record<string, string> = {
  tags: "Tags",
  refs: "Refs",
  email: "Email",
  date_added: "Date Added",
  ip_address: "IP Address",
};

export const fieldIcons: Record<string, typeof Tag> = {
  tags: Tag,
  refs: Layers,
  email: Mail,
  date_added: Calendar,
  ip_address: Globe,
};

export const unaryOperators = [
  "is_empty",
  "is_not_empty",
  "has_any_tag",
  "has_no_tags",
  "has_any_ref",
  "has_no_refs",
];

export function makeEmptyCondition(): SegmentCondition {
  return { type: "condition", field: "email", operator: "contains", value: "", value2: null };
}

export function makeEmptyGroup(): SegmentGroup {
  return { type: "group", combinator: "AND", children: [makeEmptyCondition()] };
}

export function defaultRootGroup(): SegmentGroup {
  return makeEmptyGroup();
}

export function getRulesAsV2(rules: unknown): SegmentGroup {
  if (rules && typeof rules === "object" && (rules as any).version === 2) {
    return (rules as SegmentRulesV2).root;
  }
  if (Array.isArray(rules) && rules.length > 0) {
    return migrateRulesV1toV2(rules).root;
  }
  return defaultRootGroup();
}

export function isConditionValid(c: SegmentCondition): boolean {
  if (unaryOperators.includes(c.operator)) return true;
  if (typeof c.value === "string") return c.value.trim().length > 0;
  if (Array.isArray(c.value)) return c.value.length > 0;
  return false;
}

export function hasValidCondition(group: SegmentGroup): boolean {
  for (const child of group.children) {
    if (child.type === "condition" && isConditionValid(child)) return true;
    if (child.type === "group" && hasValidCondition(child)) return true;
  }
  return false;
}

export function ConditionRow({
  condition,
  onChange,
  onRemove,
  testIdPrefix,
}: {
  condition: SegmentCondition;
  onChange: (c: SegmentCondition) => void;
  onRemove: () => void;
  testIdPrefix: string;
}) {
  const operators = fieldOperatorsV2[condition.field as keyof typeof fieldOperatorsV2] || [];
  const isUnary = unaryOperators.includes(condition.operator);
  const isBetween = condition.operator === "between";
  const isDays = condition.operator === "in_last_days" || condition.operator === "not_in_last_days";
  const isDate = condition.operator === "before" || condition.operator === "after";
  const isTagText = condition.operator === "has_tag" || condition.operator === "not_has_tag";

  const handleFieldChange = (field: string) => {
    const newOps = fieldOperatorsV2[field as keyof typeof fieldOperatorsV2];
    const opValid = (newOps as readonly string[]).includes(condition.operator);
    onChange({
      ...condition,
      field: field as SegmentCondition["field"],
      operator: opValid ? condition.operator : newOps[0],
      value: "",
      value2: null,
    });
  };

  const handleOperatorChange = (op: string) => {
    const wasUnary = unaryOperators.includes(condition.operator);
    const nowUnary = unaryOperators.includes(op);
    onChange({
      ...condition,
      operator: op,
      value: nowUnary ? null : wasUnary ? "" : condition.value,
      value2: op === "between" ? (condition.value2 || "") : null,
    });
  };

  const FieldIcon = fieldIcons[condition.field] || Tag;

  return (
    <div className="flex gap-2 items-center flex-wrap">
      <Select value={condition.field} onValueChange={handleFieldChange}>
        <SelectTrigger className="w-36" data-testid={`${testIdPrefix}-field`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {Object.entries(fieldLabels).map(([key, label]) => {
            const Icon = fieldIcons[key] || Tag;
            return (
              <SelectItem key={key} value={key}>
                <span className="flex items-center gap-1">
                  <Icon className="h-3 w-3" /> {label}
                </span>
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>

      <Select value={condition.operator} onValueChange={handleOperatorChange}>
        <SelectTrigger className="w-44" data-testid={`${testIdPrefix}-operator`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {operators.map((op) => (
            <SelectItem key={op} value={op}>
              {operatorLabelsV2[op]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {!isUnary && (
        <>
          {isBetween ? (
            <div className="flex gap-2 flex-1 min-w-[150px]">
              <Input
                type="date"
                value={typeof condition.value === "string" ? condition.value : ""}
                onChange={(e) => onChange({ ...condition, value: e.target.value })}
                className="flex-1"
                data-testid={`${testIdPrefix}-value`}
              />
              <Input
                type="date"
                value={condition.value2 || ""}
                onChange={(e) => onChange({ ...condition, value2: e.target.value })}
                className="flex-1"
                data-testid={`${testIdPrefix}-value2`}
              />
            </div>
          ) : isDays ? (
            <Input
              type="number"
              min={1}
              placeholder="Days"
              value={typeof condition.value === "string" ? condition.value : ""}
              onChange={(e) => onChange({ ...condition, value: e.target.value })}
              className="w-24"
              data-testid={`${testIdPrefix}-value`}
            />
          ) : isDate ? (
            <Input
              type="date"
              value={typeof condition.value === "string" ? condition.value : ""}
              onChange={(e) => onChange({ ...condition, value: e.target.value })}
              className="flex-1 min-w-[150px]"
              data-testid={`${testIdPrefix}-value`}
            />
          ) : isTagText ? (
            <Input
              placeholder="Tag value..."
              value={typeof condition.value === "string" ? condition.value : ""}
              onChange={(e) =>
                onChange({ ...condition, value: e.target.value.toUpperCase() })
              }
              className="flex-1 min-w-[150px]"
              data-testid={`${testIdPrefix}-value`}
            />
          ) : (
            <Input
              placeholder={
                condition.field === "email"
                  ? "e.g., @gmail.com"
                  : condition.field === "ip_address"
                  ? "e.g., 192.168.1"
                  : "Value..."
              }
              value={typeof condition.value === "string" ? condition.value : ""}
              onChange={(e) => onChange({ ...condition, value: e.target.value })}
              className="flex-1 min-w-[150px]"
              data-testid={`${testIdPrefix}-value`}
            />
          )}
        </>
      )}

      <Button
        variant="ghost"
        size="icon"
        onClick={onRemove}
        data-testid={`${testIdPrefix}-remove`}
      >
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
}

export function GroupBuilder({
  group,
  onChange,
  onRemove,
  depth,
  testIdPrefix,
}: {
  group: SegmentGroup;
  onChange: (g: SegmentGroup) => void;
  onRemove?: () => void;
  depth: number;
  testIdPrefix: string;
}) {
  const updateChild = (index: number, child: SegmentCondition | SegmentGroup) => {
    const newChildren = [...group.children];
    newChildren[index] = child;
    onChange({ ...group, children: newChildren });
  };

  const removeChild = (index: number) => {
    if (group.children.length <= 1) return;
    onChange({ ...group, children: group.children.filter((_, i) => i !== index) });
  };

  const addCondition = () => {
    onChange({ ...group, children: [...group.children, makeEmptyCondition()] });
  };

  const addNestedGroup = () => {
    onChange({ ...group, children: [...group.children, makeEmptyGroup()] });
  };

  const isRoot = depth === 0;
  const wrapperClass = isRoot ? "space-y-3" : "border rounded-md p-3 space-y-3";

  return (
    <div className={wrapperClass} data-testid={`${testIdPrefix}-group`}>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <Layers className="h-4 w-4 text-muted-foreground" />
          <Select
            value={group.combinator}
            onValueChange={(v) => onChange({ ...group, combinator: v as "AND" | "OR" })}
          >
            <SelectTrigger className="w-32" data-testid={`${testIdPrefix}-combinator`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="AND">Match ALL</SelectItem>
              <SelectItem value="OR">Match ANY</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex gap-1 flex-wrap">
          <Button
            variant="outline"
            size="sm"
            onClick={addCondition}
            data-testid={`${testIdPrefix}-add-condition`}
          >
            <Plus className="h-4 w-4 mr-1" />
            Condition
          </Button>
          {depth < 3 && (
            <Button
              variant="outline"
              size="sm"
              onClick={addNestedGroup}
              data-testid={`${testIdPrefix}-add-group`}
            >
              <Layers className="h-4 w-4 mr-1" />
              Group
            </Button>
          )}
          {onRemove && (
            <Button
              variant="ghost"
              size="icon"
              onClick={onRemove}
              data-testid={`${testIdPrefix}-remove-group`}
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {group.children.map((child, index) => (
        <div key={index} className="space-y-2">
          {index > 0 && (
            <Badge
              variant="outline"
              className="text-xs"
              data-testid={`${testIdPrefix}-connector-${index}`}
            >
              {group.combinator}
            </Badge>
          )}
          {child.type === "condition" ? (
            <ConditionRow
              condition={child}
              onChange={(c) => updateChild(index, c)}
              onRemove={() => removeChild(index)}
              testIdPrefix={`${testIdPrefix}-c${index}`}
            />
          ) : (
            <GroupBuilder
              group={child}
              onChange={(g) => updateChild(index, g)}
              onRemove={() => removeChild(index)}
              depth={depth + 1}
              testIdPrefix={`${testIdPrefix}-g${index}`}
            />
          )}
        </div>
      ))}
    </div>
  );
}
