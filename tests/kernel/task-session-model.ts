/** Business oracle for one editor and one asynchronous conversion. No src
 * imports: input versions, ownership and review are modeled directly. */
export type TaskSessionEvent =
  | { kind: 'type'; text: string }
  | { kind: 'remote'; target: 'a' | 'b'; value: number }
  | { kind: 'retarget'; target: 'a' | 'b' }
  | { kind: 'complete'; wrongExecution: boolean; wrongSession: boolean; text?: string }
  | { kind: 'detach' | 'attach' | 'confirm' | 'cancel-task' | 'cancel-session' | 'consume' | 'reapply' | 'stale-reapply' }
export type Decision = 'accepted' | 'ignored' | 'rejected' | 'invalid'
type Input = { id: string; version: number; text: string; disposition: string; by: number | null }

export class ReferenceTaskSession {
  phase: 'running' | 'blocked' | 'superseded' | 'cancelled' | 'consumed' = 'running'
  result = false
  resultText: string | null = null
  private wrongResultSession = false
  session = true
  attached = true
  target: 'a' | 'b' = 'a'
  base = 0
  authority = { a: 0, b: 0 }
  version = 0
  text = 'original text'
  retained = false
  readonly inputs: Input[] = [
    { id: 'editor', version: 0, text: 'original text', disposition: 'session', by: null },
    { id: 'file', version: 0, text: 'original file', disposition: 'task', by: null },
  ]
  private terminal() { return this.phase === 'cancelled' || this.phase === 'consumed' }
  private replace(text: string) {
    const previous = this.inputs.find(input => input.id === 'editor' && input.version === this.version)!
    previous.disposition = 'superseded'; previous.by = ++this.version
    this.text = text
    this.inputs.push({ id: 'editor', version: this.version, text, disposition: 'session', by: null })
  }
  private acceptResult() {
    this.replace(this.resultText!); this.retained = true
    this.inputs.find(input => input.id === 'file')!.disposition = 'session'
    this.phase = 'consumed'
  }
  apply(event: TaskSessionEvent): Decision {
    switch (event.kind) {
      case 'remote': this.authority[event.target] = event.value; return 'accepted'
      case 'detach':
        if (!this.session || !this.attached) return 'invalid'
        this.attached = false; return 'accepted'
      case 'attach':
        if (!this.session || this.attached) return 'invalid'
        this.attached = true; return 'accepted'
      case 'type':
      case 'retarget':
      case 'confirm':
        if (!this.session || !this.attached) return 'invalid'
        if (event.kind === 'retarget') this.target = event.target
        if (event.kind !== 'type') this.base = this.authority[this.target]
        this.replace(event.kind === 'type' ? event.text : this.text)
        if (!this.terminal()) this.phase = 'superseded'
        return 'accepted'
      case 'cancel-session':
        if (!this.session) return 'invalid'
        this.session = false; this.attached = false
        for (const input of this.inputs) if (input.disposition === 'session') input.disposition = 'cancelled-session'
        if (!this.terminal()) {
          this.phase = 'cancelled'; this.inputs.find(input => input.id === 'file')!.disposition = 'cancelled-task'
        }
        return 'accepted'
      case 'cancel-task':
        if (this.terminal()) return 'ignored'
        this.phase = 'cancelled'; this.inputs.find(input => input.id === 'file')!.disposition = 'cancelled-task'
        return 'accepted'
      case 'complete':
        if (event.wrongExecution || this.terminal() || this.result || this.phase === 'blocked') return 'ignored'
        this.result = true
        this.resultText = event.text ?? 'converted result'
        this.wrongResultSession = event.wrongSession
        if (this.phase === 'superseded') return 'accepted'
        if (event.wrongSession || this.authority.a !== 0) this.phase = 'blocked'
        else this.acceptResult()
        return 'accepted'
      case 'consume':
      case 'reapply':
      case 'stale-reapply':
        if (this.terminal()) return 'ignored'
        if (!this.result || !this.session || event.kind === 'stale-reapply') return 'rejected'
        if (event.kind === 'consume' && this.phase === 'superseded') return 'rejected'
        if (this.authority[this.target] !== this.base) return 'rejected'
        // A blocked mismatched result needs review, even with unchanged data.
        if (event.kind === 'consume' && this.wrongResultSession) return 'rejected'
        this.acceptResult(); return 'accepted'
    }
  }
}
