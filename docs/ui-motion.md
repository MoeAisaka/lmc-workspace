# Interaction and motion

Use the shared adapters for first-party actions:

```tsx
import { InteractionPressable as Pressable } from '@/components/InteractionPressable';

<Pressable interaction="control" onPress={submit}>...</Pressable>
```

The default `surface` feedback is for list rows and cards: a quiet hover/press tint with no positional change. Use `control` for compact buttons and chips to add a small pressure response to their content, keeping the button's hit area fixed. Use `none` for click-away hit planes and elements whose visual response belongs to a parent. Existing events, disabled behavior, styles, custom data attributes and refs stay with React Native. Legacy opacity controls use `InteractionTouchableOpacity`.

`interaction.css` supplies feedback without pointer-move listeners or a render loop. Adapted controls use the native press-in/out/cancel lifecycle instead of browser `:active`, which can remain latched after a touch tap. Native HTML buttons, links and ARIA action roles also receive hover and keyboard-focus styling. Keyboard focus is a visible ring, independent of whether animation is enabled. Ordinary input fields receive a matching ring. The composer uses `dataSet={{ 'yulor-focus-within': 'composer' }}` for a quiet neutral inset on focus; it keeps its elevation shadow and leaves the outer edge clear for the working rainbow ring.

Reuse `AnimatedPopup`, `FloatingOverlay` and `BaseModal` rather than inventing another transition. They respect the existing full/gentle/off personalization; system reduced motion takes precedence. Keep `exitImmediately` for actions that must remove a hit plane immediately. Reorder transforms remain functional when decorative settling is disabled. Native press feedback also respects the system setting; no native binary release is implied by a web deployment.

Animate color, opacity and small transforms. Do not animate chat widths/heights, replace an element to show focus, alter scroll/caret state, or add a permanent pointer/animation loop. Hover is restricted to hover-capable fine pointers so touch does not retain a hover highlight.

Check real controls in light/dark at phone and desktop widths, using pointer press/release, keyboard navigation, disabled states, inputs and menus. Repeat with gentle/off and system reduced motion. Confirm that actions dispatch once and that a hover or focus change does not move the hit area or lose an unsent draft.

References: [W3C interaction animation](https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions), [MDN reduced motion](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/%40media/prefers-reduced-motion).

Use `DashboardCard` for information cards (usage summaries, quotas, traffic, devices and strategy groups). It stays a plain `View`, preserving selection and the tab order. Its hover and focus-within overlay has no hit area or root transform; nested cards highlight the innermost hovered/focused card. Put actions inside the card on the shared press adapter. Use `DashboardChevron` for disclosure arrows and `dataSet={{ 'yulor-disclosure': 'content' }}` on conditionally mounted detail containers for a short fade without animated heights. Both follow the same motion preferences.

Click-away hit planes are not visible controls: always set `interaction="none"` on their Pressable, including full-screen account/settings menus, file/context popovers and drawer scrims. A transparent fullscreen Pressable with default feedback turns the whole page grey on hover/press. Nonmodal menu backdrops stay transparent; explicit modal/focus-mode dimming belongs to the dedicated backdrop layer.

Use `SegmentedTabs` for equal-width tab controls: one selection surface slides behind fixed hit areas. Its buttons use `interaction="none"` and `data-yulor-tab` so hover/press only emphasizes the label, avoiding a second stationary background beside the moving pill. Keyboard focus remains visible. Pair it with `StableTabPanels` when two Web panes differ in height. Both stay mounted in the same intrinsic grid track, reserving the taller pane without measuring or animating height; inactive panes are inert and hidden from accessibility. Switching only translates the panes, using the existing full/gentle/off and reduced-motion preferences. Follow the [W3C tabs keyboard pattern](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/) and keep [inert](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Global_attributes/inert) on the inactive pane so its controls cannot take focus.

Hover overlays inherit their owner's radius and use equal insets on all edges. If an interactive row sits inside a rounded card, keep its inset uniform: the sidebar account card uses 3px padding plus its 1px border for a 4px inset on every side, with outer radius 16px and row radius 12px. Multi-action cards retain separate row/button targets; do not apply whole-card actions just to draw a highlight.

Give compact hover targets their own corner radius: a rounded parent does not round a child's feedback surface. The queue mode footer uses 8px. Regular text-copy and image-copy actions share a 28×28 frame with an 8px radius and a 16px glyph; the compact queue copy variant keeps its 26×26 frame and 8px radius. Keep these changes on the control's style rather than applying a blanket radius to every action role.


Use `interactionGeometry.ts` for standalone glyph actions: `iconActionFrame` reserves 28×28 with an 8px radius and prevents flex compression; `smallIconActionFrame` reserves 20×20 with a 6px radius for removal controls inside compact chips. `textActionFrame` supplies minimum height and padding without constraining a text label to an icon square. Keep existing larger controls at their intended dimensions. Give a control its own geometry before relying on inherited pseudo-element rounding; an ancestor radius only clips descendants when overflow is clipped.

The feedback layer uses the owner’s padding box, equal zero insets, inherited per-corner radii and no pointer events. Do not attach feedback to invisible focus proxies, context-hit anchors, keyboard-dismiss planes or click-away backdrops: mark adapted/HTML targets `interaction="none"` / `data-yulor-interaction="none"`. Such proxies must not suppress their visible parent’s feedback. When a real inner control receives hover or keyboard focus, its dashboard card defers the outer glow. Inline prose links use text emphasis instead of a rectangular surface.

Keep full-width lists, table cells, chart coordinate regions and grouped edge rows aligned with their own container; they do not use a universal icon size or radius. In browser verification, compare pseudo-element dimensions with the owner’s local client dimensions, since a legitimate ancestor transform can scale both together. Check compact actions at 320px as well as desktop widths, with nested controls, disabled states, press cancellation, touch and reduced motion. Static source coverage does not replace visual checks of loaded feature states.


The account popover reserves the available frame above its anchor from its first visible render. Quota, optional rows and hidden traffic panels may change asynchronously; they scroll inside the frame rather than remeasure and move it. A flexible content spacer keeps navigation actions near the lower edge when there is spare room. The composer’s model overview and drill-in share 6px top/bottom content padding and 6px row side insets; allow the content-height popup to grow for this padding. Circular Send feedback uses a 50% radius on its existing full-size target, without changing its parent’s dimensions. The traffic refresh control matches the AI refresh control at 32×32/r16, including its loading state.
