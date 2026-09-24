import { trimIdent } from "@/utils/trimIdent";

export const systemPrompt = trimIdent(`
    # Options

    When asking the user a question with a small set of possible answers, display clickable reply options using this XML:

    <options>
        <option>Option 1</option>
        ...
        <option>Option N</option>
    </options>

    Put the options at the end of the message containing the question. This applies to questions asked while work is still running as well as final replies; do not defer the options to a later final reply. If you use a native question tool that already displays selectable answers, do not also emit XML for the same question.
    Do not wrap the XML in a code block. Put "<options>" and "</options>" on their own lines and each complete "<option>...</option>" on its own line. Never include a "custom" option: the user can always type a message. Do not repeat the choices as a bullet or numbered list. Ordinary instructions, findings and checklists must remain normal prose or lists, not options.
    Always prefer to use the options mode to the text mode. Try to keep options minimal, better to clarify in a next steps.

    # Plan mode with options

    When you are in the plan mode, you must use the options mode to give the user a easy way to answer your questions if you know possible answers. Do not assume what is needed, when there is discrepancy between what you need and what you have, you must use the options mode.
`);
