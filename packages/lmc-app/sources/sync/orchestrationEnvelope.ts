/**
 * The two envelopes a hub and its workers exchange.
 *
 * Plain text with a fixed shape, carried as agent mail. Plain text because it
 * has to cross two engines and two machines through a channel that only moves
 * strings, and be readable by a person in the transcript; fixed shape because
 * a hub reviewing twenty reports cannot afford to parse prose. The first line
 * names the kind, the task id and the attempt; the rest is `field  value`
 * lines, a field continuing onto indented lines below it.
 *
 *   [task lmc-42 · attempt 1]
 *   goal        …
 *   scope       path
 *               path
 *   acceptance  - check
 *               - check
 *
 *   [report lmc-42 · attempt 1 · done]
 *   summary     …
 *   changes     branch @ sha
 *   verification …
 *   questions   …
 */

export const TASK_FIELDS = ['stage', 'goal', 'scope', 'acceptance', 'constraints', 'deliver', 'run'] as const;
/** Where in a task's life this envelope sits; matches the worker duties. */
export const TASK_STAGES = ['build', 'review', 'verify', 'deploy'] as const;
export const REPORT_FIELDS = ['summary', 'changes', 'verification', 'questions', 'blocked', 'cost', 'model', 'evidence'] as const;
export const REPORT_STATUSES = ['done', 'blocked', 'failed'] as const;
export const REVIEW_FIELDS = ['summary', 'reasons'] as const;
export const REVIEW_STATUSES = ['accepted', 'rejected'] as const;

export type TaskField = typeof TASK_FIELDS[number];
export type ReportField = typeof REPORT_FIELDS[number];
export type ReportStatus = typeof REPORT_STATUSES[number];
export type ReviewField = typeof REVIEW_FIELDS[number];
export type ReviewStatus = typeof REVIEW_STATUSES[number];

export interface TaskEnvelope {
    kind: 'task';
    id: string;
    attempt: number;
    fields: Partial<Record<TaskField, string>>;
}
export interface ReportEnvelope {
    kind: 'report';
    id: string;
    attempt: number;
    status: ReportStatus;
    fields: Partial<Record<ReportField, string>>;
}
/** The hub's (or the person's) verdict on a report. */
export interface ReviewEnvelope {
    kind: 'review';
    id: string;
    attempt: number;
    status: ReviewStatus;
    fields: Partial<Record<ReviewField, string>>;
}
export type Envelope = TaskEnvelope | ReportEnvelope | ReviewEnvelope;

/** Where the hub's context goes if this is not bounded; evidence may run longer. */
export const ENVELOPE_LIMITS = { field: 1200, evidence: 4000, total: 12000 } as const;

// Written by a model, so read generously. The head may share its line with
// the first field, the parts may be separated by ·, |, - or a comma, "attempt"
// may be "#", a sentence or two may precede it, and a field may be written
// `name: value` as well as `name  value`. What must hold: a recognisable head,
// and known field names.
// Anchored to the start of its line: an envelope mentioned mid-sentence is a
// mention. Parts after the id may be separated by ·, |, comma, dash or space.
const HEAD = /^\s*\[(task|report|review)\s+([A-Za-z0-9][A-Za-z0-9._-]{0,63})((?:[\s·|,\-]+[^\]·|,\s][^\]·|,]*)*)\]/i;
const FIELD = /^([a-z]+)(?:\s{2,}|\t+|\s*:\s+|:\s*)(.*)$/i;

/** Whether this text carries an envelope head near its top — cheap, for routing. */
export function looksLikeEnvelope(text: string): boolean {
    return HEAD.test(text.split('\n').slice(0, 3).join('\n'));
}

export function parseEnvelope(text: string): Envelope | null {
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    // The head has to appear within the first few non-empty lines; further
    // down it is a quotation, not an envelope.
    let headAt = -1;
    let seen = 0;
    for (let i = 0; i < lines.length && seen < 3; i++) {
        if (!lines[i].trim()) continue;
        seen += 1;
        if (HEAD.test(lines[i])) { headAt = i; break; }
    }
    if (headAt < 0) return null;
    const head = HEAD.exec(lines[headAt])!;
    const kind = head[1].toLowerCase() as 'task' | 'report' | 'review';
    const id = head[2];
    const extras = head[3] ?? '';
    const attemptMatch = /(?:attempt|#)\s*(\d{1,3})/i.exec(extras) ?? /(?:^|[·|,\-]\s*)(\d{1,3})(?=\s*(?:[·|,\-]|$))/.exec(extras);
    const attempt = attemptMatch ? Number(attemptMatch[1]) : 1;
    const statusMatch = /\b(done|blocked|failed|accepted|rejected)\b/i.exec(extras);
    // Whatever followed the head on its own line is the first line of the body.
    const afterHead = lines[headAt].slice(head.index + head[0].length).trim();
    const bodyLines = [afterHead, ...lines.slice(headAt + 1)];
    const allowed: readonly string[] = kind === 'task' ? TASK_FIELDS : kind === 'report' ? REPORT_FIELDS : REVIEW_FIELDS;
    const fields: Record<string, string> = {};
    let current: string | null = null;
    for (const raw of bodyLines) {
        if (!raw.trim()) { if (current) fields[current] += '\n'; continue; }
        const m = FIELD.exec(raw.trim());
        const name = m ? m[1].toLowerCase() : null;
        if (name && allowed.includes(name)) {
            current = name;
            fields[name] = (fields[name] ? fields[name] + '\n' : '') + (m![2] ?? '').trim();
        } else if (current) {
            fields[current] += '\n' + raw.trim();
        }
    }
    for (const key of Object.keys(fields)) fields[key] = fields[key].trim().slice(0, key === 'evidence' ? ENVELOPE_LIMITS.evidence : ENVELOPE_LIMITS.field);
    if (kind === 'task') return { kind, id, attempt, fields };
    if (kind === 'review') return { kind: 'review', id, attempt, status: statusMatch?.[1].toLowerCase() === 'rejected' ? 'rejected' : 'accepted', fields };
    const status = (statusMatch && (REPORT_STATUSES as readonly string[]).includes(statusMatch[1].toLowerCase()) ? statusMatch[1].toLowerCase() : (fields.blocked ? 'blocked' : 'done')) as ReportStatus;
    return { kind: 'report', id, attempt, status, fields };
}

function formatFields(order: readonly string[], fields: Record<string, string | undefined>): string[] {
    const width = Math.max(...order.map((f) => f.length)) + 2;
    const out: string[] = [];
    for (const name of order) {
        const value = fields[name]?.trim();
        if (!value) continue;
        const [first, ...rest] = value.split('\n');
        out.push(name.padEnd(width) + first);
        for (const line of rest) out.push(' '.repeat(width) + line);
    }
    return out;
}

export function formatTaskEnvelope(task: Omit<TaskEnvelope, 'kind'>): string {
    return [`[task ${task.id} · attempt ${task.attempt}]`, ...formatFields(TASK_FIELDS, task.fields)].join('\n').slice(0, ENVELOPE_LIMITS.total);
}

export function formatReportEnvelope(report: Omit<ReportEnvelope, 'kind'>): string {
    return [`[report ${report.id} · attempt ${report.attempt} · ${report.status}]`, ...formatFields(REPORT_FIELDS, report.fields)].join('\n').slice(0, ENVELOPE_LIMITS.total);
}

export function formatReviewEnvelope(review: Omit<ReviewEnvelope, 'kind'>): string {
    return [`[review ${review.id} · attempt ${review.attempt} · ${review.status}]`, ...formatFields(REVIEW_FIELDS, review.fields)].join('\n').slice(0, ENVELOPE_LIMITS.total);
}

/** A task is dispatchable only if the worker can know what done looks like. */
export function taskIsComplete(task: TaskEnvelope): boolean {
    return !!task.fields.goal && !!task.fields.acceptance;
}
