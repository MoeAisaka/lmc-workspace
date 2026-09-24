import { useChatMaxWidth } from './ChatWidthContext';
import * as React from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { MarkdownView } from "./markdown/MarkdownView";
import { t } from '@/text';
import { Message, UserTextMessage, AgentTextMessage, ToolCallMessage } from "@/sync/typesMessage";
import { Metadata } from "@/sync/storageTypes";
import { ToolView } from "./tools/ToolView";
import { AgentEvent } from "@/sync/typesRaw";
import { sync } from '@/sync/sync';
import { useSetting } from '@/sync/storage';
import { Option } from './markdown/MarkdownView';
import { layout } from "./layout";
import { parseLocalCommandMessage, isUserSlashCommandEcho } from './parseLocalCommandMessage';
import { resolveUserMessageBubbleColor } from '@/utils/userMessageBubbleColor';
import { LongPressCopyable } from './LongPressCopyable';
import { useMessageFlavor } from './MessageEngineContext';
import { isHandoffDelivery } from '@/sync/engineHandoff';
import { isEngineSwitchRequest, switchDurationEndingAt } from '@/sync/engineSwitchProgress';
import { EngineSwitchCard } from './lmc/EngineSwitchCard';
import { EnvelopeCard, MailBlock } from './lmc/OrchestrationCards';
import { isMailDelivery } from '@/sync/orchestrationTasks';
import { parseEnvelope, type Envelope } from '@/sync/orchestrationEnvelope';
import { useSessionMessages } from '@/sync/storage';


/**
 * assign_task / report_task inputs as an envelope. The attempt is known only
 * when the model gave one; 0 means unknown and the card leaves it out. The
 * runner's board, not this card, is the record.
 */
function envelopeFromToolInput(name: string, input: unknown): { envelope: Envelope; counterpartId: string | null } | null {
  if (!input || typeof input !== 'object') return null;
  const i = input as Record<string, unknown>;
  const str = (k: string) => (typeof i[k] === 'string' ? (i[k] as string) : undefined);
  const attempt = typeof i.attempt === 'number' ? i.attempt : 0;
  if (name.endsWith('assign_task') && typeof i.id === 'string') {
    return { envelope: { kind: 'task', id: i.id, attempt, fields: { stage: str('stage'), goal: str('goal'), scope: str('scope'), acceptance: str('acceptance'), constraints: str('constraints'), deliver: str('deliver'), run: str('run') } }, counterpartId: str('sessionId') ?? null };
  }
  if (name.endsWith('report_task') && typeof i.id === 'string') {
    const status = i.status === 'blocked' || i.status === 'failed' ? i.status : 'done';
    return { envelope: { kind: 'report', id: i.id, attempt, status, fields: { summary: str('summary'), changes: str('changes'), verification: str('verification'), questions: str('questions'), blocked: str('blocked') } }, counterpartId: null };
  }
  return null;
}

export const MessageView = React.memo((props: {
  message: Message;
  metadata: Metadata | null;
  sessionId: string;
  getMessageById?: (id: string) => Message | null;
  copyText?: string;
}) => {
  const chatMaxWidth = useChatMaxWidth();
  return (
    <View
      style={styles.messageContainer}
      renderToHardwareTextureAndroid={Platform.OS !== 'web'}
    >
      <View style={[styles.messageContent, { maxWidth: chatMaxWidth }]}>
        <RenderBlock
          message={props.message}
          metadata={props.metadata}
          sessionId={props.sessionId}
          getMessageById={props.getMessageById}
          copyText={props.copyText}
        />
      </View>
    </View>
  );
});

// RenderBlock function that dispatches to the correct component based on message kind
function RenderBlock(props: {
  message: Message;
  metadata: Metadata | null;
  sessionId: string;
  getMessageById?: (id: string) => Message | null;
  copyText?: string;
}): React.ReactElement {
  switch (props.message.kind) {
    case 'user-text':
      return (
        <UserTextBlock
          message={props.message}
          metadata={props.metadata}
          sessionId={props.sessionId}
        />
      );

    case 'agent-text':
      return <AgentTextBlock message={props.message} sessionId={props.sessionId} copyText={props.copyText} />;

    case 'tool-call':
      return <ToolCallBlock
        message={props.message}
        metadata={props.metadata}
        sessionId={props.sessionId}
        getMessageById={props.getMessageById}
      />;

    case 'agent-event':
      return <AgentEventBlock event={props.message.event} metadata={props.metadata} sessionId={props.sessionId} createdAt={props.message.createdAt} />;


    default:
      // Exhaustive check - TypeScript will error if we miss a case
      const _exhaustive: never = props.message;
      throw new Error(`Unknown message kind: ${_exhaustive}`);
  }
}

function UserTextBlock(props: {
  message: UserTextMessage;
  metadata: Metadata | null;
  sessionId: string;
}) {
  const handleOptionPress = React.useCallback((option: Option) => {
    sync.sendMessage(props.sessionId, option.title, { source: 'option' });
  }, [props.sessionId]);

  const userMessageBubbleColor = useSetting('userMessageBubbleColor');
  const { theme } = useUnistyles();
  const bubblePalette = resolveUserMessageBubbleColor(userMessageBubbleColor, theme.dark);
  const bubbleStyle = {
    backgroundColor: bubblePalette.background,
    borderColor: bubblePalette.border,
  };
  // Claude Agent SDK emits synthetic user messages wrapped in tags like
  // <local-command-caveat>…</local-command-caveat> and
  // <command-message>…</command-message><command-name>/foo</command-name>
  // whenever a slash command runs. The plain MarkdownView renders these as
  // literal text, which looks broken. Collapse them into chips or hide
  // them entirely depending on what kind of wrapper this is.
  // The user's own slash-command input is shown optimistically (carries a
  // localId); the SDK then injects the canonical wrapper chip. Hide the raw
  // echo so we don't render the command twice. Gated to Claude flavor only:
  // Codex/Gemini don't reliably emit the <command-*> wrapper, so hiding the
  // echo there would drop the command with nothing to replace it. (Absent
  // flavor == Claude, matching the convention used elsewhere.)
  // After an engine switch the session flavor describes the engine running
  // now, not the one that wrote the messages above the handoff — ask for this
  // message's own.
  const flavor = useMessageFlavor(props.message.id, props.metadata?.flavor);
  const isClaudeFlavor = !flavor || flavor === 'claude';
  if (isClaudeFlavor && isUserSlashCommandEcho(props.message.text, props.message.localId != null)) {
    return null;
  }

  // The engine reads the briefing as a user message because that is the only
  // way in; the transcript shows it as the handoff boundary above instead.
  if (isHandoffDelivery(props.message.text, props.message.localId != null, props.message.displayText)) {
    return null;
  }
  // The request that starts an engine switch is shown as the switch itself:
  // one card that follows it from here to the handoff rule below.
  if (isEngineSwitchRequest(props.message.text)) {
    return <EngineSwitchCard sessionId={props.sessionId} message={props.message} />;
  }
  // Mail from another session arrives as a user message with the runner's
  // framing; drawn as a card that names the sender, not as the user's bubble.
  if (isMailDelivery(props.message.text)) {
    return <MailBlock text={props.message.text} />;
  }

  const parsed = parseLocalCommandMessage(props.message.displayText || props.message.text);
  if (parsed.kind === 'caveat') {
    return null;
  }
  if (parsed.kind === 'goal-confirmation') {
    return null;
  }
  if (parsed.kind === 'goal-run') {
    return (
      <View style={styles.userMessageContainer}>
        <LongPressCopyable style={styles.userCopyTarget} text={parsed.goal}>
          <View style={[styles.userMessageBubble, styles.userMessageBubbleSolid, bubbleStyle, styles.goalMessageBubble]}>
            <MarkdownView externalCopyHandler markdown={parsed.goal} onOptionPress={handleOptionPress} sessionId={props.sessionId} />
          </View>
          <View style={styles.goalSentRow}>
            <Ionicons name="locate-outline" size={16} color={styles.goalSentText.color} />
            <Text style={styles.goalSentText}>{t('message.sentAsGoal')}</Text>
          </View>
        </LongPressCopyable>
      </View>
    );
  }
  if (parsed.kind === 'command-run') {
    const commandText = parsed.args ? `/${parsed.commandName} ${parsed.args}` : `/${parsed.commandName}`;
    return (
      <View style={styles.userMessageContainer}>
        <LongPressCopyable style={styles.userCopyTarget} text={commandText}>
          {parsed.args ? (
            <View style={[styles.userMessageBubble, styles.userMessageBubbleSolid, bubbleStyle, styles.commandMessageBubble]}>
              <MarkdownView externalCopyHandler markdown={parsed.args} onOptionPress={handleOptionPress} sessionId={props.sessionId} />
            </View>
          ) : null}
          <View style={[styles.commandChip, styles.userMessageBubbleSolid, bubbleStyle]}>
            <Text style={styles.commandChipText}>/{parsed.commandName}</Text>
          </View>
        </LongPressCopyable>
      </View>
    );
  }

  return (
    <View style={styles.userMessageContainer}>
      {/* Long-press copies the whole message through our own menu rather than the
          OS selection callout. Rewind remains in session actions. */}
      <LongPressCopyable style={styles.userCopyTarget} text={parsed.text}>
        <View style={[styles.userMessageBubble, styles.userMessageBubbleSolid, bubbleStyle]}>
          <MarkdownView externalCopyHandler markdown={parsed.text} onOptionPress={handleOptionPress} sessionId={props.sessionId} />
        </View>
      </LongPressCopyable>
    </View>
  );
}

function AgentTextBlock(props: {
  message: AgentTextMessage;
  sessionId: string;
  copyText?: string;
}) {
  const handleOptionPress = React.useCallback((option: Option) => {
    sync.sendMessage(props.sessionId, option.title, { source: 'option' });
  }, [props.sessionId]);

  // Hide thinking messages
  if (props.message.isThinking) {
    return null;
  }

  return (
    <View style={styles.agentMessageContainer}>
      <MarkdownView markdown={props.message.text} inferOptions onOptionPress={handleOptionPress} sessionId={props.sessionId} />
      {props.copyText ? <MessageCopyButton text={props.copyText} /> : null}
    </View>
  );
}

// The glyph is deliberately small, so widen the touch target well past it.
const COPY_HIT_SLOP = { top: 14, bottom: 14, left: 14, right: 20 };

function MessageCopyButton(props: { text: string }) {
  const { theme } = useUnistyles();
  const [copied, setCopied] = React.useState(false);
  const resetTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => () => {
    if (resetTimerRef.current) {
      clearTimeout(resetTimerRef.current);
    }
  }, []);

  const handleCopy = React.useCallback(async () => {
    try {
      await Clipboard.setStringAsync(props.text);
      setCopied(true);
      if (resetTimerRef.current) {
        clearTimeout(resetTimerRef.current);
      }
      resetTimerRef.current = setTimeout(() => setCopied(false), 1500);
    } catch (error) {
      console.error('Failed to copy message:', error);
    }
  }, [props.text]);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={copied ? t('common.copied') : t('common.copy')}
      hitSlop={COPY_HIT_SLOP}
      onPress={handleCopy}
      style={({ pressed }) => [
        styles.copyAction,
        pressed && styles.copyActionPressed,
      ]}
    >
      <Ionicons
        name={copied ? 'checkmark' : 'copy-outline'}
        size={16}
        color={theme.colors.text}
      />
    </Pressable>
  );
}

/**
 * Where one engine handed the session to another.
 *
 * Drawn as a rule across the transcript rather than another centred line,
 * because it is the one event that divides the conversation: everything above
 * it was written by a different engine, which cannot see anything below. It
 * opens to show exactly what crossed — the whole point of a lossy handover is
 * that the reader can check what the next engine was actually told, and fill in
 * what it was not.
 */
function EngineHandoffBlock(props: { from: string; source: 'engine' | 'compiled'; briefing: string; sessionId: string; createdAt: number }) {
  const { theme } = useUnistyles();
  const [open, setOpen] = React.useState(false);
  // The progress card folds into this rule when the switch completes, so the
  // time the switch took lives here — measured from the request that began it.
  const { messages } = useSessionMessages(props.sessionId);
  const took = React.useMemo(() => switchDurationEndingAt(messages, props.createdAt), [messages, props.createdAt]);
  return (
    <View style={styles.handoffContainer}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((current) => !current)}
        style={styles.handoffHeader}
      >
        <View style={[styles.handoffRule, { backgroundColor: theme.colors.divider }]} />
        <Ionicons name="swap-horizontal-outline" size={14} color={theme.colors.agentEventText} />
        <Text style={styles.handoffLabel}>
          {props.source === 'engine'
            ? t('message.handoffFrom', { engine: props.from })
            : t('message.handoffCompiled', { engine: props.from })}
          {took != null ? ` · ${t('lmc.engineSwitch.took', { seconds: Math.max(1, Math.round(took / 1000)) })}` : ''}
        </Text>
        <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={13} color={theme.colors.agentEventText} />
        <View style={[styles.handoffRule, { backgroundColor: theme.colors.divider }]} />
      </Pressable>
      {open && (
        <View style={[styles.handoffBody, { borderColor: theme.colors.divider }]}>
          <Text selectable style={styles.handoffText}>{props.briefing}</Text>
        </View>
      )}
    </View>
  );
}

function AgentEventBlock(props: {
  event: AgentEvent;
  metadata: Metadata | null;
  sessionId: string;
  createdAt: number;
}) {
  if (props.event.type === 'engine-switch-cancelled') {
    // The card standing where the request was says so; a second line would say it twice.
    return null;
  }
  if (props.event.type === 'engine-handoff') {
    return <EngineHandoffBlock from={props.event.from} source={props.event.source} briefing={props.event.briefing} sessionId={props.sessionId} createdAt={props.createdAt} />;
  }
  if (props.event.type === 'switch') {
    return (
      <View style={styles.agentEventContainer}>
        <Text style={styles.agentEventText}>{t('message.switchedToMode', { mode: props.event.mode })}</Text>
      </View>
    );
  }
  if (props.event.type === 'message') {
    return (
      <View style={styles.agentEventContainer}>
        <Text style={styles.agentEventText}>{props.event.message}</Text>
      </View>
    );
  }
  if (props.event.type === 'limit-reached') {
    const formatTime = (timestamp: number): string => {
      try {
        const date = new Date(timestamp * 1000); // Convert from Unix timestamp
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      } catch {
        return t('message.unknownTime');
      }
    };

    return (
      <View style={styles.agentEventContainer}>
        <Text style={styles.agentEventText}>
          {t('message.usageLimitUntil', { time: formatTime(props.event.endsAt) })}
        </Text>
      </View>
    );
  }
  return (
    <View style={styles.agentEventContainer}>
      <Text style={styles.agentEventText}>{t('message.unknownEvent')}</Text>
    </View>
  );
}

function ToolCallBlock(props: {
  message: ToolCallMessage;
  metadata: Metadata | null;
  sessionId: string;
  getMessageById?: (id: string) => Message | null;
}) {
  if (!props.message.tool) {
    return null;
  }
  // A task or report this session sent through agent mail: the envelope is
  // the message, so it is drawn as one rather than as a tool call.
  if (props.message.tool.name.endsWith('send_to_session') && typeof props.message.tool.input?.text === 'string') {
    const envelope = parseEnvelope(props.message.tool.input.text);
    if (envelope) {
      return <EnvelopeCard envelope={envelope} direction="out" counterpartId={typeof props.message.tool.input.sessionId === 'string' ? props.message.tool.input.sessionId : null} />;
    }
  }
  // The structured tools carry the envelope as fields; drawn as the same card.
  const structured = envelopeFromToolInput(props.message.tool.name, props.message.tool.input);
  if (structured) {
    return <EnvelopeCard envelope={structured.envelope} direction="out" counterpartId={structured.counterpartId} />;
  }
  return (
    <View style={styles.toolContainer}>
      <ToolView
        tool={props.message.tool}
        metadata={props.metadata}
        messages={props.message.children}
        sessionId={props.sessionId}
        messageId={props.message.id}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  messageContainer: {
    flexDirection: 'row',
    justifyContent: 'center',
  },
  messageContent: {
    flexDirection: 'column',
    flexGrow: 1,
    flexBasis: 0,
    minWidth: 0,
    maxWidth: layout.maxWidth,
    overflow: 'hidden',
  },
  userMessageContainer: {
    maxWidth: '100%',
    flexDirection: 'column',
    alignItems: 'flex-end',
    justifyContent: 'flex-end',
    paddingHorizontal: 16,
  },
  userMessageBubble: {
    backgroundColor: theme.colors.userMessageBackground,
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 12,
    marginBottom: 4,
    maxWidth: '100%',
  },
  userMessageBubbleSolid: {
    borderWidth: Platform.select({ web: 0, default: StyleSheet.hairlineWidth }),
    overflow: 'hidden',
  },
  goalMessageBubble: {
    marginBottom: 6,
  },
  commandMessageBubble: {
    marginBottom: 6,
  },
  goalSentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 4,
    maxWidth: '100%',
    opacity: 0.72,
  },
  goalSentText: {
    color: theme.colors.agentEventText,
    fontSize: 14,
  },
  commandChip: {
    backgroundColor: theme.colors.userMessageBackground,
    borderColor: theme.colors.divider,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 2,
    borderRadius: 10,
    marginBottom: 4,
    maxWidth: '100%',
    opacity: 0.65,
  },
  commandChipText: {
    color: theme.colors.input.text,
    fontSize: 13,
    fontFamily: 'monospace',
  },
  agentMessageContainer: {
    // Symmetric, so a tool row reads the same distance from the text whether
    // it lands above or below it. Total rhythm matches the old 4 + 16.
    marginHorizontal: 16,
    marginVertical: 10,
    // Same radius as the composer card, so every block in the column shares
    // one corner.
    borderRadius: 20,
    maxWidth: '100%',
  },
  copyAction: {
    // No width, so the box shrink-wraps the glyph and its left edge lands on the
    // same x as the markdown text above it. hitSlop carries the touch target.
    alignSelf: 'flex-start',
    height: 20,
    justifyContent: 'center',
    // Sits fully below the last markdown block's trailing margin, clear of the
    // reply text.
    marginTop: 0,
  },
  copyActionPressed: {
    opacity: 0.5,
  },
  userCopyTarget: {
    alignItems: 'flex-end',
    maxWidth: '100%',
  },
  agentEventContainer: {
    marginHorizontal: 16,
    alignItems: 'center',
    paddingVertical: 8,
  },
  agentEventText: {
    color: theme.colors.agentEventText,
    fontSize: 14,
  },
  handoffContainer: { marginHorizontal: 16, paddingVertical: 10, gap: 8 },
  handoffHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  handoffRule: { flex: 1, height: StyleSheet.hairlineWidth },
  handoffLabel: { color: theme.colors.agentEventText, fontSize: 12 },
  handoffBody: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 12 },
  handoffText: { color: theme.colors.agentEventText, fontSize: 12, lineHeight: 18 },
  toolContainer: {
    marginHorizontal: 16,
    maxWidth: '100%',
    overflow: 'hidden',
  },
  debugText: {
    color: theme.colors.agentEventText,
    fontSize: 12,
  },
}));
