// Shared structural surface for the rolling-message modules (status,
// progress, task-mirror). Defining it here — outside any consumer — lets
// progress-reporter.ts and task-mirror.ts both depend on it without one
// having to import from the other. Avoids the cross-module dependency we
// previously had (task-mirror imported the interface from progress-reporter).
//
// Compatible by structural typing with the production `TelegramApi` from
// `src/channel/tools.ts`. Tests can stub it with a plain object literal.

export interface TelegramApiForProgress {
  sendMessage(
    chatId: string,
    text: string,
    opts: { parse_mode?: 'HTML' | 'MarkdownV2'; reply_to_message_id?: number; background?: boolean },
  ): Promise<{ message_id: number }>
  editMessageText(
    chatId: string,
    messageId: number,
    text: string,
    opts: { parse_mode?: 'HTML' | 'MarkdownV2'; background?: boolean },
  ): Promise<void>
}
