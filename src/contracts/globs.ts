interface Transition {
  to: number;
  matches: (character: string) => boolean;
}

interface GlobMachine {
  expression: RegExp;
  epsilon: Map<number, Set<number>>;
  transitions: Map<number, Transition[]>;
  accept: number;
  alphabet: string[];
}

function addEpsilon(machine: GlobMachine, from: number, to: number): void {
  const destinations = machine.epsilon.get(from) ?? new Set<number>();
  destinations.add(to);
  machine.epsilon.set(from, destinations);
}

function addTransition(machine: GlobMachine, from: number, transition: Transition): void {
  const transitions = machine.transitions.get(from) ?? [];
  transitions.push(transition);
  machine.transitions.set(from, transitions);
}

function epsilonClosure(machine: GlobMachine, states: Iterable<number>): Set<number> {
  const closure = new Set(states);
  const pending = [...closure];
  while (pending.length > 0) {
    const state = pending.pop()!;
    for (const destination of machine.epsilon.get(state) ?? []) {
      if (closure.has(destination)) continue;
      closure.add(destination);
      pending.push(destination);
    }
  }
  return closure;
}

function move(machine: GlobMachine, states: Set<number>, character: string): Set<number> {
  const destinations = new Set<number>();
  for (const state of states) {
    for (const transition of machine.transitions.get(state) ?? []) {
      if (transition.matches(character)) destinations.add(transition.to);
    }
  }
  return epsilonClosure(machine, destinations);
}

function stateKey(states: Set<number>): string {
  return [...states].sort((left, right) => left - right).join(",");
}

function acceptsEveryProjectPath(machine: GlobMachine): boolean {
  const start = epsilonClosure(machine, [0]);
  const pending: Set<number>[] = [];
  const visited = new Set<string>();
  for (const character of machine.alphabet.filter((candidate) => candidate !== "/")) {
    const next = move(machine, start, character);
    if (!next.has(machine.accept)) return false;
    const key = stateKey(next);
    if (!visited.has(key)) {
      visited.add(key);
      pending.push(next);
    }
  }
  while (pending.length > 0) {
    const states = pending.pop()!;
    for (const character of machine.alphabet) {
      const next = move(machine, states, character);
      if (!next.has(machine.accept)) return false;
      const key = stateKey(next);
      if (!visited.has(key)) {
        visited.add(key);
        pending.push(next);
      }
    }
  }
  return true;
}

function compileGlob(glob: string): GlobMachine {
  let expression = "";
  let state = 0;
  const literalCharacters = new Set<string>();
  const machine: GlobMachine = {
    expression: /$^/,
    epsilon: new Map(),
    transitions: new Map(),
    accept: 0,
    alphabet: [],
  };
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index] ?? "";
    let nextState = state + 1;
    if (character === "*" && glob[index + 1] === "*" && glob[index + 2] === "/") {
      expression += "(?:.*/)?";
      const directoryState = nextState;
      nextState += 1;
      addEpsilon(machine, state, nextState);
      addTransition(machine, state, { to: directoryState, matches: () => true });
      addTransition(machine, state, { to: nextState, matches: (candidate) => candidate === "/" });
      addTransition(machine, directoryState, { to: directoryState, matches: () => true });
      addTransition(machine, directoryState, { to: nextState, matches: (candidate) => candidate === "/" });
      index += 2;
    } else if (character === "*" && glob[index + 1] === "*") {
      expression += ".*";
      addEpsilon(machine, state, nextState);
      addTransition(machine, state, { to: state, matches: () => true });
      index += 1;
    } else if (character === "*") {
      expression += "[^/]*";
      addEpsilon(machine, state, nextState);
      addTransition(machine, state, { to: state, matches: (candidate) => candidate !== "/" });
    } else if (character === "?") {
      expression += "[^/]";
      addTransition(machine, state, { to: nextState, matches: (candidate) => candidate !== "/" });
    } else {
      expression += character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      literalCharacters.add(character);
      addTransition(machine, state, { to: nextState, matches: (candidate) => candidate === character });
    }
    state = nextState;
  }
  let other = "\u0001";
  while (literalCharacters.has(other) || other === "/") other = String.fromCodePoint(other.codePointAt(0)! + 1);
  machine.expression = new RegExp(`^${expression}$`, "s");
  machine.accept = state;
  machine.alphabet = [...literalCharacters, ...(literalCharacters.has("/") ? [] : ["/"]), other];
  return machine;
}

export function globMatches(glob: string, path: string): boolean {
  return compileGlob(glob).expression.test(path);
}

export function globMatchesEveryProjectPath(glob: string): boolean {
  return acceptsEveryProjectPath(compileGlob(glob));
}
