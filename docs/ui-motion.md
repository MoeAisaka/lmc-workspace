# Interaction and motion

Use the shared adapters for first-party actions:

```tsx
import { InteractionPressable as Pressable } from '@/components/InteractionPressable';

<Pressable interaction="control" onPress={submit}>...</Pressable>
```

The default `surface` feedback is for list rows and cards: a quiet hover/press tint with no positional change. Use `control` for compact buttons and chips to add a small pressure response to their content, keeping the button's hit area fixed. Use `none` for click-away hit planes and elements whose visual response belongs to a parent. Existing events, disabled behavior, styles, custom data attributes and refs stay with React Native. Legacy opacity controls use `InteractionTouchableOpacity`.

`interaction.css` supplies feedback without pointer-move listeners or a render loop. Adapted controls use the native press-in/out/cancel lifecycle instead of browser `:active`, which can remain latched after a touch tap. Native HTML buttons, links and ARIA action roles also receive hover and keyboard-focus styling. Keyboard focus is a visible ring, independent of whether animation is enabled. Input fields receive a matching ring; add `dataSet={{ 'yulor-focus-within': 'composer' }}` to an input shell for a single focus boundary.

Reuse `AnimatedPopup`, `FloatingOverlay` and `BaseModal` rather than inventing another transition. They respect the existing full/gentle/off personalization; system reduced motion takes precedence. Keep `exitImmediately` for actions that must remove a hit plane immediately. Reorder transforms remain functional when decorative settling is disabled. Native press feedback also respects the system setting; no native binary release is implied by a web deployment.

Animate color, opacity and small transforms. Do not animate chat widths/heights, replace an element to show focus, alter scroll/caret state, or add a permanent pointer/animation loop. Hover is restricted to hover-capable fine pointers so touch does not retain a hover highlight.

Check real controls in light/dark at phone and desktop widths, using pointer press/release, keyboard navigation, disabled states, inputs and menus. Repeat with gentle/off and system reduced motion. Confirm that actions dispatch once and that a hover or focus change does not move the hit area or lose an unsent draft.

References: [W3C interaction animation](https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions), [MDN reduced motion](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/%40media/prefers-reduced-motion).

Use `DashboardCard` for information cards (usage summaries, quotas, traffic, devices and strategy groups). It stays a plain `View`, preserving selection and the tab order. Its hover and focus-within overlay has no hit area or root transform; nested cards highlight the innermost hovered/focused card. Put actions inside the card on the shared press adapter. Use `DashboardChevron` for disclosure arrows and `dataSet={{ 'yulor-disclosure': 'content' }}` on conditionally mounted detail containers for a short fade without animated heights. Both follow the same motion preferences.

Click-away hit planes are not visible controls: always set `interaction="none"` on their Pressable, including full-screen account/settings menus, file/context popovers and drawer scrims. A transparent fullscreen Pressable with default feedback turns the whole page grey on hover/press. Nonmodal menu backdrops stay transparent; explicit modal/focus-mode dimming belongs to the dedicated backdrop layer.
