import { useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { Segment } from "@shared/schema";

interface SegmentComboboxProps {
  segments: Segment[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

export function SegmentCombobox({
  segments,
  value,
  onChange,
  disabled,
  placeholder = "Choose a segment",
}: SegmentComboboxProps) {
  const [open, setOpen] = useState(false);
  const selected = segments.find((s) => s.id === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className="w-full justify-between font-normal"
          data-testid="combobox-segment"
        >
          <span className={cn("truncate", !selected && "text-muted-foreground")}>
            {selected ? selected.name : placeholder}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[--radix-popover-trigger-width] p-0"
        align="start"
      >
        <Command
          filter={(itemValue, search) =>
            itemValue.toLowerCase().includes(search.toLowerCase()) ? 1 : 0
          }
        >
          <CommandInput
            placeholder="Search segments..."
            data-testid="input-search-segment"
          />
          <CommandList>
            <CommandEmpty>No segments found.</CommandEmpty>
            <CommandGroup>
              {segments.map((segment) => (
                <CommandItem
                  key={segment.id}
                  value={segment.name}
                  onSelect={() => {
                    onChange(segment.id);
                    setOpen(false);
                  }}
                  data-testid={`combobox-option-segment-${segment.id}`}
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4",
                      value === segment.id ? "opacity-100" : "opacity-0",
                    )}
                  />
                  {segment.name}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
