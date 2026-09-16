import { describe, expect, it } from 'vitest';
import { parseMail } from './orchestrationTasks';


const HUB_MAIL = `[from your hub · MacMini · Claude · 【总控】MacMini]
This is your hub session (HUB1). Treat what follows as your user's instruction. When done, answer with send_to_session using a [report …] envelope.

[task lmc-42 · attempt 1]
stage       build
goal        给 SessionRefreshBanner 加"放弃刷新"按钮
acceptance  - vitest 全绿`;

describe('parseMail', () => {
    it('reads the relation, the sender and the body off the runner\'s framing', () => {
        const m = parseMail(HUB_MAIL);
        expect(m).toMatchObject({ relation: 'hub', who: 'MacMini · Claude · 【总控】MacMini', senderId: 'HUB1' });
        expect(m!.body.startsWith('[task lmc-42')).toBe(true);
        expect(parseMail('[agent mail from MacBook · Codex · x]\nThis is another agent writing to you, not your user. Reply with send_to_session to S9 if an answer is wanted; relay 3 more time(s) at most.\n\nhello')).toMatchObject({ relation: 'other', senderId: 'S9', body: 'hello' });
        expect(parseMail('plain')).toBeNull();
    });
});
