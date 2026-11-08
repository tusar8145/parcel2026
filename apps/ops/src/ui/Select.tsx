/**
 * A drop-in for <select>: the same props and <option> / <optgroup> children, drawn as the panel's dropdown
 * (SearchSelect). A long list (more than 8 choices: hubs, riders, merchants, zones…) gets a search box, like
 * shared/select-search.js did for the classic panel. onChange receives `{ target: { value } }`.
 */
import { Children, isValidElement, useState, type ReactNode, type SelectHTMLAttributes } from "react";
import { SearchSelect, type Option } from "./SearchSelect";
import type { IconName } from "./Icon";

const SEARCH_FROM = 8;

type Props = Omit<SelectHTMLAttributes<HTMLSelectElement>, "onChange" | "value" | "defaultValue"> & {
  value?: string | number;
  defaultValue?: string | number;
  onChange?: (event: { target: { value: string } }) => void;
  /** Force (true) or never (false) the search box; by default only long lists have one. */
  searchable?: boolean;
  /** An icon before the text. */
  icon?: IconName;
};

const text = (node: ReactNode): string =>
  Children.toArray(node)
    .map(n => (typeof n === "string" || typeof n === "number" ? String(n) : isValidElement<{ children?: ReactNode }>(n) ? text(n.props.children) : ""))
    .join("");

function collect(children: ReactNode, group?: string, out: (Option & { hidden?: boolean })[] = []) {
  Children.forEach(children, child => {
    if (!isValidElement<{ value?: string | number; children?: ReactNode; label?: string; disabled?: boolean; hidden?: boolean }>(child)) return;
    if (child.type === "option") {
      const label = text(child.props.children);
      out.push({ value: child.props.value != null ? String(child.props.value) : label, label, group, disabled: child.props.disabled, hidden: child.props.hidden });
    } else if (child.type === "optgroup") collect(child.props.children, child.props.label, out);
    else collect(child.props.children, group, out);
  });
  return out;
}

export function Select({ children, value, defaultValue, onChange, searchable, icon, className = "", style, disabled, id, ...rest }: Props) {
  const [own, setOwn] = useState(String(defaultValue ?? ""));
  const options = collect(children);
  const choices = options.filter(o => o.value !== "");
  const current = value != null ? String(value) : own;
  const change = (v: string) => {
    if (value == null) setOwn(v);
    onChange?.({ target: { value: v } });
  };
  const empty = options.find(o => o.value === "");
  return (
    <SearchSelect
      id={id}
      label={(rest["aria-label"] as string) || (rest.title as string) || "Choose"}
      options={choices}
      emptyLabel={empty && !empty.hidden ? empty.label : undefined}
      placeholder={empty?.label || "Choose…"}
      value={current}
      onChange={change}
      size={/\bsm\b/.test(className) ? "sm" : "md"}
      disabled={disabled}
      invalid={rest["aria-invalid"] === true || rest["aria-invalid"] === "true"}
      width={style?.width ?? (/\bsm\b/.test(className) ? "auto" : "100%")}
      search={searchable ?? choices.length > SEARCH_FROM}
      icon={icon}
      title={rest.title as string | undefined}
    />
  );
}
