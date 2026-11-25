import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

const formatPart = (value: number) => String(value).padStart(2, '0');
const hours = Array.from({ length: 24 }, (_, index) => index);
const minutes = Array.from({ length: 60 }, (_, index) => index);
const popupGap = 6;
const viewportGap = 8;
const preferredPopupHeight = 216;
const minAnchoredPopupHeight = 80;

type TimeColumnProps = {
  label: string;
  options: number[];
  value: number;
  onChange: (value: number) => void;
};

function TimeColumn({ label, options, value, onChange }: TimeColumnProps) {
  const id = useId();
  const list = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const column = list.current;
    if (!column) return;
    const revealSelection = () => {
      const selected = column.querySelector<HTMLElement>('[aria-selected="true"]');
      if (!selected) return;
      const top = selected.offsetTop;
      if (top < column.scrollTop || top + selected.offsetHeight > column.scrollTop + column.clientHeight) {
        column.scrollTop = top - (column.clientHeight - selected.offsetHeight) / 2;
      }
    };
    revealSelection();
    const observer = new ResizeObserver(revealSelection);
    observer.observe(column);
    return () => observer.disconnect();
  }, [value]);

  return <div className="sidebar-time-column">
    <div className="sidebar-time-column-label" id={`${id}-label`}>{label}</div>
    <div
      ref={list}
      className="sidebar-time-options"
      role="listbox"
      tabIndex={0}
      aria-labelledby={`${id}-label`}
      aria-activedescendant={`${id}-${value}`}
      onKeyDown={event => {
        const last = options.length - 1;
        const nextByKey: Partial<Record<string, number>> = {
          ArrowUp: Math.max(0, value - 1),
          ArrowDown: Math.min(last, value + 1),
          Home: 0,
          End: last,
        };
        const next = nextByKey[event.key];
        if (typeof next !== 'number') return;
        event.preventDefault();
        onChange(next);
      }}
    >
      {options.map(option => <div
        key={option}
        id={`${id}-${option}`}
        className="sidebar-time-option"
        role="option"
        aria-selected={option === value}
        onClick={() => {
          list.current?.focus({ preventScroll: true });
          onChange(option);
        }}
      >{formatPart(option)}</div>)}
    </div>
  </div>;
}

type TimePickerProps = {
  labelledBy: string;
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
};

export default function TimePicker({ labelledBy, value, disabled, onChange }: TimePickerProps) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const expanded = open && !disabled;
  const [hour, minute] = value.split(':').map(Number);

  useLayoutEffect(() => {
    const button = trigger.current;
    const panel = popup.current;
    if (!expanded || !button || !panel) return;

    const positionPopup = () => {
      const { clientWidth, clientHeight } = document.documentElement;
      const rect = button.getBoundingClientRect();
      if (rect.bottom <= 0 || rect.top >= clientHeight) {
        setOpen(false);
        return;
      }

      // Fixed coordinates keep the popup outside the field box's overflow clip.
      const above = rect.top - popupGap - viewportGap;
      const below = clientHeight - rect.bottom - popupGap - viewportGap;
      const opensBelow = below >= preferredPopupHeight || below >= above;
      const available = opensBelow ? below : above;
      const useViewport = available < minAnchoredPopupHeight;
      const height = Math.min(preferredPopupHeight, useViewport ? clientHeight - 2 * viewportGap : available);
      const width = Math.min(rect.width, clientWidth - 2 * viewportGap);
      const left = Math.min(Math.max(rect.left, viewportGap), clientWidth - viewportGap - width);
      const top = useViewport
        ? Math.max(viewportGap, (clientHeight - height) / 2)
        : opensBelow ? rect.bottom + popupGap : rect.top - popupGap - height;
      Object.assign(panel.style, { top: `${top}px`, left: `${left}px`, width: `${width}px`, height: `${height}px` });
    };
    const onScroll = (event: Event) => {
      if (!(event.target instanceof Node && panel.contains(event.target))) positionPopup();
    };

    positionPopup();
    panel.querySelector<HTMLElement>('[role="listbox"]')?.focus({ preventScroll: true });
    window.addEventListener('resize', positionPopup);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('resize', positionPopup);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [expanded]);

  useEffect(() => {
    if (!expanded) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [expanded]);

  return <div
    ref={root}
    className="sidebar-time-picker"
    onBlur={event => {
      if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
    }}
    onKeyDown={event => {
      if (!expanded || event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus({ preventScroll: true });
    }}
  >
    <button
      ref={trigger}
      type="button"
      className="sidebar-time-toggle"
      disabled={disabled}
      aria-labelledby={`${labelledBy} ${id}-value`}
      aria-haspopup="dialog"
      aria-expanded={expanded}
      aria-controls={expanded ? `${id}-popup` : undefined}
      onClick={() => setOpen(previous => !previous)}
    >
      <span id={`${id}-value`}>{value}</span>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9" /><path d="M12 7v5h4" />
      </svg>
    </button>
    {expanded && <div ref={popup} id={`${id}-popup`} className="sidebar-time-popup" role="dialog" aria-labelledby={labelledBy}>
      <TimeColumn label="小时" options={hours} value={hour} onChange={next => onChange(`${formatPart(next)}:${formatPart(minute)}`)} />
      <TimeColumn label="分钟" options={minutes} value={minute} onChange={next => onChange(`${formatPart(hour)}:${formatPart(next)}`)} />
    </div>}
  </div>;
}
