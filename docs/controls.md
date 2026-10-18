# Shared controls

Controls live in `src/components/shared`; their material and states are in
`src/styles/controls.css`. They use the current theme, accent, artwork palette,
font and reduced-motion preferences. Use these instead of adding native buttons,
select menus or checkbox styling to a feature.

```tsx
import { Button } from "../shared/Button"
import { Checkbox, Switch } from "../shared/Checkbox"
import { Select } from "../shared/Select"

<Button variant="primary" size="md" onClick={save}>Save changes</Button>
<Button onClick={cancel}>Cancel</Button>
<label><Checkbox checked={enabled} onChange={e => setEnabled(e.target.checked)} />Enabled</label>
<Select aria-label="Order" value={order} onChange={e => setOrder(e.target.value)}>
  <option value="added">Date added</option>
  <option value="title">Title</option>
</Select>
```

`Button` defaults to a small secondary action and `type="button"`. Use an explicit
`type="submit"` for forms. Variants are `primary`, `secondary`, `ghost`, `danger`,
`menu` and `bare`; sizes are `sm`, `md` and `icon`. `bare` preserves specialized
card, transport, tab and row layouts while sharing focus and disabled behavior.
Use `aria-pressed` for toggle buttons. Icon-only actions need an accessible name.

`Checkbox` and `Switch` are native inputs, so wrapping labels, Space, disabled
fieldsets and form submission work normally. `Checkbox` also accepts
`indeterminate`. They forward an input ref.

`Select` accepts single-select props and ordinary `option`/`optgroup` children,
including disabled options/groups. `value`, `defaultValue`, `name`, `form` and
`onChange` retain native select semantics; its ref points to the hidden form
select. Focus, blur, click and keyboard handlers target the visible button.
Use `className` for the wrapper's layout and `size` for the control size.
Provide `aria-label`, `aria-labelledby`, a wrapping label or an explicit label
with `htmlFor` matching `id`.

The list supports arrow keys, Home/End, typeahead, Enter/Space, Escape and Tab.
It inherits the trigger's palette and stays within the viewport. Top-layer
popovers escape clipping; the list stays inside its owning modal for focus
isolation, with a positioned fallback for older WebViews.

For richer dropdowns, use `DropdownSurface` with your feature's positioning,
focus and dismissal logic. Action rows use `MenuItem` from
`ContextMenuPrimitives`, which shares the button menu variant. Search and the
library chooser retain their specialized interactions on this common material.

Run `bun run test:controls` for the focused Chromium/WebKit fixture. It covers
keyboard and pointer selection, form values/reset, labels, disabled controls,
checkboxes/switches, modal stacking, and narrow light/dark layouts. It uses a
temporary fixture build and leaves the running dev server alone.
