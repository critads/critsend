import { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight, ChevronUp, ChevronDown, X, Calendar } from "lucide-react";

interface DateTimePickerProps {
  value: Date | null;
  onChange: (date: Date | null) => void;
  label?: string;
}

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function toParisDate(date: Date): { year: number; month: number; day: number; hours: number; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const get = (type: string) => parseInt(parts.find(p => p.type === type)?.value || "0", 10);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hours: get("hour") === 24 ? 0 : get("hour"),
    minutes: get("minute"),
  };
}

function fromParisTime(year: number, month: number, day: number, hours: number, minutes: number): Date {
  const pad = (n: number) => String(n).padStart(2, "0");
  const localStr = `${year}-${pad(month)}-${pad(day)}T${pad(hours)}:${pad(minutes)}:00`;

  const guessUtc = new Date(localStr + "Z");
  for (const offsetMinutes of [60, 120]) {
    const candidate = new Date(guessUtc.getTime() - offsetMinutes * 60000);
    const check = toParisDate(candidate);
    if (check.year === year && check.month === month && check.day === day && check.hours === hours && check.minutes === minutes) {
      return candidate;
    }
  }

  return new Date(localStr + "+01:00");
}

function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

function getFirstDayOfMonth(year: number, month: number): number {
  const d = new Date(year, month - 1, 1).getDay();
  return d === 0 ? 6 : d - 1;
}

export default function DateTimePicker({ value, onChange, label }: DateTimePickerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [isOpen]);

  const [viewYear, setViewYear] = useState(() => {
    if (value) return toParisDate(value).year;
    return toParisDate(new Date()).year;
  });
  const [viewMonth, setViewMonth] = useState(() => {
    if (value) return toParisDate(value).month;
    return toParisDate(new Date()).month;
  });
  const [selectedHours, setSelectedHours] = useState(() => {
    if (value) return toParisDate(value).hours;
    return 9;
  });
  const [selectedMinutes, setSelectedMinutes] = useState(() => {
    if (value) return toParisDate(value).minutes;
    return 0;
  });

  useEffect(() => {
    if (value) {
      const paris = toParisDate(value);
      setViewYear(paris.year);
      setViewMonth(paris.month);
      setSelectedHours(paris.hours);
      setSelectedMinutes(paris.minutes);
    }
  }, [value]);

  const selectedParis = value ? toParisDate(value) : null;

  const prevMonth = useCallback(() => {
    if (viewMonth === 1) {
      setViewMonth(12);
      setViewYear(y => y - 1);
    } else {
      setViewMonth(m => m - 1);
    }
  }, [viewMonth]);

  const nextMonth = useCallback(() => {
    if (viewMonth === 12) {
      setViewMonth(1);
      setViewYear(y => y + 1);
    } else {
      setViewMonth(m => m + 1);
    }
  }, [viewMonth]);

  const selectDay = useCallback((day: number) => {
    const newDate = fromParisTime(viewYear, viewMonth, day, selectedHours, selectedMinutes);
    onChange(newDate);
  }, [viewYear, viewMonth, selectedHours, selectedMinutes, onChange]);

  const updateTime = useCallback((hours: number, minutes: number) => {
    setSelectedHours(hours);
    setSelectedMinutes(minutes);
    if (selectedParis) {
      const newDate = fromParisTime(selectedParis.year, selectedParis.month, selectedParis.day, hours, minutes);
      onChange(newDate);
    }
  }, [selectedParis, onChange]);

  const incrementHours = () => updateTime((selectedHours + 1) % 24, selectedMinutes);
  const decrementHours = () => updateTime((selectedHours + 23) % 24, selectedMinutes);
  const incrementMinutes = () => {
    const newMin = (selectedMinutes + 5) % 60;
    updateTime(selectedMinutes + 5 >= 60 ? (selectedHours + 1) % 24 : selectedHours, newMin);
  };
  const decrementMinutes = () => {
    const newMin = (selectedMinutes - 5 + 60) % 60;
    updateTime(selectedMinutes - 5 < 0 ? (selectedHours + 23) % 24 : selectedHours, newMin);
  };

  const clearValue = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChange(null);
    setIsOpen(false);
  };

  const daysInMonth = getDaysInMonth(viewYear, viewMonth);
  const firstDay = getFirstDayOfMonth(viewYear, viewMonth);

  const displayValue = selectedParis
    ? `${selectedParis.day.toString().padStart(2, "0")}/${selectedParis.month.toString().padStart(2, "0")}/${selectedParis.year} ${selectedParis.hours.toString().padStart(2, "0")}:${selectedParis.minutes.toString().padStart(2, "0")}`
    : "";

  const todayParis = toParisDate(new Date());

  return (
    <div className="relative" ref={containerRef} data-testid="date-time-picker">
      <div
        className="flex items-center h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm cursor-pointer hover:border-primary/50 transition-colors"
        onClick={() => setIsOpen(!isOpen)}
        data-testid="input-schedule"
      >
        <Calendar className="h-4 w-4 mr-2 text-muted-foreground" />
        {displayValue ? (
          <span>{displayValue}</span>
        ) : (
          <span className="text-muted-foreground">Select date and time...</span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {value && (
            <button
              type="button"
              onClick={clearValue}
              className="p-0.5 rounded hover:bg-muted"
              data-testid="button-clear-schedule"
            >
              <X className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          )}
        </div>
      </div>

      {isOpen && (
        <div className="absolute z-50 mt-1 w-[320px] rounded-lg border bg-popover p-4 shadow-lg" data-testid="date-time-picker-popover">
          <div className="flex items-center justify-between mb-3">
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={prevMonth} data-testid="button-prev-month">
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="text-sm font-medium">
              {MONTHS[viewMonth - 1]} {viewYear}
            </span>
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={nextMonth} data-testid="button-next-month">
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>

          <div className="grid grid-cols-7 gap-0 mb-1">
            {DAYS.map(d => (
              <div key={d} className="text-center text-xs font-medium text-muted-foreground py-1">
                {d}
              </div>
            ))}
          </div>

          <div className="grid grid-cols-7 gap-0">
            {Array.from({ length: firstDay }).map((_, i) => (
              <div key={`empty-${i}`} className="h-8" />
            ))}
            {Array.from({ length: daysInMonth }).map((_, i) => {
              const day = i + 1;
              const isSelected = selectedParis?.year === viewYear && selectedParis?.month === viewMonth && selectedParis?.day === day;
              const isToday = todayParis.year === viewYear && todayParis.month === viewMonth && todayParis.day === day;

              return (
                <button
                  key={day}
                  type="button"
                  onClick={() => selectDay(day)}
                  className={`h-8 w-full rounded text-sm transition-colors
                    ${isSelected ? "bg-primary text-primary-foreground font-medium" : "hover:bg-muted"}
                    ${isToday && !isSelected ? "border border-primary/50 font-medium" : ""}
                  `}
                  data-testid={`button-day-${day}`}
                >
                  {day}
                </button>
              );
            })}
          </div>

          <div className="mt-4 pt-3 border-t">
            <div className="flex items-center justify-center gap-3">
              <div className="flex flex-col items-center gap-0.5">
                <Button variant="ghost" size="icon" className="h-6 w-6" onClick={incrementHours} data-testid="button-hour-up">
                  <ChevronUp className="h-3.5 w-3.5" />
                </Button>
                <span className="text-2xl font-mono font-medium tabular-nums w-10 text-center" data-testid="text-hours">
                  {selectedHours.toString().padStart(2, "0")}
                </span>
                <Button variant="ghost" size="icon" className="h-6 w-6" onClick={decrementHours} data-testid="button-hour-down">
                  <ChevronDown className="h-3.5 w-3.5" />
                </Button>
              </div>
              <span className="text-2xl font-mono font-medium">:</span>
              <div className="flex flex-col items-center gap-0.5">
                <Button variant="ghost" size="icon" className="h-6 w-6" onClick={incrementMinutes} data-testid="button-minute-up">
                  <ChevronUp className="h-3.5 w-3.5" />
                </Button>
                <span className="text-2xl font-mono font-medium tabular-nums w-10 text-center" data-testid="text-minutes">
                  {selectedMinutes.toString().padStart(2, "0")}
                </span>
                <Button variant="ghost" size="icon" className="h-6 w-6" onClick={decrementMinutes} data-testid="button-minute-down">
                  <ChevronDown className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground text-center mt-1">Paris time (CET/CEST)</p>
          </div>
        </div>
      )}
    </div>
  );
}