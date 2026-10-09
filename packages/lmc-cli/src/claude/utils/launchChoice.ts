/**
 * What an unset session field means for a runner that was launched with a value.
 *
 * A relaunch carries the model and effort the session was actually running
 * (`--model`, `--effort`), while session metadata may still hold `null` for a
 * field nobody ever picked. Reading that first snapshot as "clear it" starts
 * the engine without the value, and the very next message — which carries the
 * app's effective default — then differs from the running settings and forces
 * a second engine restart. Absence in the first snapshot is not an instruction;
 * a later change to unset is.
 */
export function resolveSessionChoice<T extends string>(input: {
    initial: boolean; launched: T | undefined; current: T | undefined; picked: T | null | undefined | '';
}): T | undefined {
    if (input.picked === undefined) return input.current;
    if (input.picked === null || input.picked === '') return input.initial && input.launched !== undefined ? input.launched : undefined;
    return input.picked;
}
