import { useCallback, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
import { useAnchoredPopover } from "../hooks/useAnchoredPopover";

type SelectValue = string | number;

export interface SelectOption<T extends SelectValue> { value: T; label: string; swatch?: string; }

interface Props<T extends SelectValue> {
  id?: string;
  label: string;
  value: T | null;
  options: readonly SelectOption<T>[];
  onChange: (value: T) => void;
  leadingIcon?: ReactNode;
  variant?: "toolbar" | "form";
  disabled?: boolean;
  title?: string;
}

export function SelectField<const T extends SelectValue>({ id, label, value, options, onChange, leadingIcon, variant, disabled, title }: Props<T>) {
  const listId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef({ text: "", at: 0 });
  const [index, setIndex] = useState<number | null>(null);
  const active = index === null || disabled || !options.length ? null : Math.min(index, options.length - 1);
  const open = active !== null;
  const selected = options.findIndex((option) => option.value === value);
  const selection = options[selected];
  const dismiss = useCallback(() => {
    setIndex(null);
    search.current.text = "";
  }, []);
  const { field, popup, portalRoot } = useAnchoredPopover(open, dismiss, { matchAnchor: true, preferBelow: variant !== undefined });

  useLayoutEffect(() => {
    if (disabled) dismiss();
  }, [disabled, dismiss]);

  useLayoutEffect(() => {
    if (active === null) return;
    const list = popup.current;
    const option = list?.children.item(active) as HTMLElement | null;
    if (!list || !option) return;
    if (option.offsetTop < list.scrollTop) list.scrollTop = option.offsetTop;
    if (option.offsetTop + option.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = option.offsetTop + option.offsetHeight - list.clientHeight;
    }
  }, [active, popup]);

  const choose = (option: SelectOption<T>) => {
    dismiss();
    trigger.current?.focus({ preventScroll: true });
    if (option.value !== value) onChange(option.value);
  };

  const handleKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled || event.nativeEvent.isComposing || !options.length) return;
    const { key } = event;
    if (key === "Tab") { dismiss(); return; }
    if (key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      dismiss();
      return;
    }
    if (key === "Enter" || key === " ") {
      event.preventDefault();
      if (active === null) setIndex(Math.max(selected, 0));
      else choose(options[active]);
      return;
    }
    if (key === "ArrowDown" || key === "ArrowUp") {
      event.preventDefault();
      const down = key === "ArrowDown";
      const start = selected >= 0 ? selected : down ? 0 : options.length - 1;
      setIndex(active === null ? start : Math.max(0, Math.min(options.length - 1, active + (down ? 1 : -1))));
      return;
    }
    if (key === "Home" || key === "End") {
      event.preventDefault();
      setIndex(key === "Home" ? 0 : options.length - 1);
      return;
    }
    if (key.length !== 1 || event.altKey || event.ctrlKey || event.metaKey) return;
    const now = Date.now();
    const letter = key.toLocaleLowerCase();
    const prefix = now - search.current.at < 600 ? search.current.text : "";
    const query = prefix === letter ? letter : prefix + letter;
    search.current = { text: query, at: now };
    const from = active ?? selected;
    for (let step = 0; step < options.length; step += 1) {
      const position = (from + (query.length === 1 ? 1 : 0) + step + options.length) % options.length;
      if (!options[position].label.toLocaleLowerCase().startsWith(query)) continue;
      event.preventDefault();
      setIndex(position);
      break;
    }
  };

  return <div ref={field} className="select-field" data-variant={variant}>
    <button id={id} ref={trigger} type="button" role="combobox" className="select-field-trigger" aria-label={label}
      title={title ?? (variant === "toolbar" ? options[selected]?.label : undefined)}
      aria-expanded={open} aria-controls={open ? listId : undefined}
      aria-activedescendant={active === null ? undefined : `${listId}-${active}`}
      disabled={!options.length} aria-disabled={disabled || undefined} onKeyDown={handleKey}
      onClick={() => {
        if (disabled) return;
        if (open) dismiss();
        else setIndex(Math.max(selected, 0));
      }}>
      {leadingIcon && <span className="select-field-icon" aria-hidden="true">{leadingIcon}</span>}
      <span className="select-field-value">
        {selection?.swatch && <span className="select-field-swatch" style={{ backgroundColor: selection.swatch }} aria-hidden="true" />}
        <span>{selection?.label ?? "请选择"}</span>
      </span>
      <ChevronDown size={14} aria-hidden="true" />
    </button>
    {open && createPortal(
      <div ref={popup} id={listId} className="select-field-popover" role="listbox" aria-label={label} data-variant={variant}
        onPointerDown={(event) => event.stopPropagation()}>
        {options.map((option, position) => <div key={option.value} id={`${listId}-${position}`} role="option"
          aria-selected={position === selected} className={active === position ? "active" : undefined}
          onPointerMove={() => setIndex(position)} onMouseDown={(event) => event.preventDefault()}
          onClick={() => choose(option)}>
          <span className="select-field-value">
            {option.swatch && <span className="select-field-swatch" style={{ backgroundColor: option.swatch }} aria-hidden="true" />}
            <span>{option.label}</span>
          </span>
          {position === selected && <Check size={14} aria-hidden="true" />}
        </div>)}
      </div>,
      portalRoot
    )}
  </div>;
}
