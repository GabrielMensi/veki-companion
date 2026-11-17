import type { ChatResult, ToolCall } from "../../src/providers";
import type { PendingActionInput, ToolHost } from "../../src/tools";

let n = 0;
export const call = (name: string, args: Record<string, unknown>): ToolCall => ({ id: `c${++n}`, name, arguments: args });
export const turn = (...toolCalls: ToolCall[]): ChatResult => ({ text: null, toolCalls, usage: { tokensIn: 10, tokensOut: 5 } });
export const say = (texto: string, botones?: { etiqueta: string; valor: string }[]) => turn(call("responder", { texto, botones }));

export class FakeHost implements ToolHost {
  readonly pending: PendingActionInput[] = [];
  async createPendingAction(input: PendingActionInput) {
    this.pending.push(input);
    return { id: `pa${this.pending.length}` };
  }
  async read(name: string) {
    return `resultado de ${name}`;
  }
}
