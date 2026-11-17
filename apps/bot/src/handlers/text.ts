import { runAgent, type AgentDeps, type AgentOutput, type ConversationStore } from "@veki/core";

export type TurnDeps = AgentDeps & { store: ConversationStore };

export type TurnReply = AgentOutput & {
  /** Dos malentendidos seguidos: avisar a Gabriel con el `update_id` (sin el texto). */
  escalate: boolean;
  misunderstood: boolean;
};

/** Carga la conversación, corre el agente y guarda estado + historial (solo texto). */
export async function runTurn(
  deps: TurnDeps,
  input: { chatId: number; text: string; lowConfidenceVoice?: boolean },
): Promise<TurnReply> {
  const snap = await deps.store.load(input.chatId);
  const res = await runAgent(deps, { state: snap.state, history: snap.history, input });
  await deps.store.save(input.chatId, { state: res.state, history: res.history }, snap.version);
  return { ...res.output, escalate: res.escalate, misunderstood: res.misunderstood };
}

/** Mensaje de texto de la usuaria. */
export function handleText(deps: TurnDeps, input: { chatId: number; text: string }): Promise<TurnReply> {
  return runTurn(deps, input);
}
