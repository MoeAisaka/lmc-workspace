import { createContext, useContext } from 'react';
import { layout } from './layout';

/**
 * Wide mode keeps a tenth of the pane as margin rather than running edge to
 * edge; the value doubles as the flag for "this column is not centred by a
 * fixed width", which the composer's gutter logic keys off.
 */
export const CHAT_WIDE_WIDTH = '90%';

// Scoped to the main conversation; settings and side chats retain their own layout.
export const ChatWidthContext = createContext<number | typeof CHAT_WIDE_WIDTH>(layout.maxWidth);
export const useChatMaxWidth = () => useContext(ChatWidthContext);
