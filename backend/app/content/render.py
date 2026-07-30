"""Re-redacción del tutorial con LLM — contrato estricto y fallback total.

El provider (app/content/llm_provider.py) re-escribe what/eli5/tip/diálogo de
cada paso adaptándolos al negocio real del usuario. Este módulo pone las
reglas deterministas alrededor:

- La salida usa el MISMO esquema que las plantillas y se valida con Pydantic.
- Guard de números: la redacción no puede introducir cifras que no existan en
  el contenido original o en el contexto del proyecto (el LLM redacta, no
  calcula — los números siempre salen del motor).
- Validación por paso: un paso inválido se descarta y ese paso sirve la
  versión autorada (fallback por slot, no por lote).
- Caché en memoria por fingerprint (proyecto + contexto + contenido + modelo):
  mismo estado, misma redacción; cambiar el contenido autorado la invalida.
- La generación corre en background: GET /onboarding nunca espera al LLM.

El quiz NUNCA se re-redacta: sus afirmaciones sobre el motor son verificadas
a mano y el doble check «entendido» depende de ellas.
"""
import hashlib
import json
import re
import threading
from typing import Literal

from pydantic import BaseModel, Field

MAX_ATTEMPTS = 3          # tras 3 fallos por fingerprint se deja de intentar
LENGTH_RATIO_MAX = 2.5    # la redacción no puede inflar un campo más de 2.5x

_lock = threading.Lock()
_cache: dict[str, dict] = {}      # fingerprint -> {step_key: rewritten_dict}
_pending: set[str] = set()
_failures: dict[str, int] = {}


class RewrittenTurn(BaseModel):
    speaker: Literal["alumno", "mentor"]
    text: str = Field(min_length=1)


class RewrittenStep(BaseModel):
    key: str
    what: str = Field(min_length=1)
    eli5: str = Field(min_length=1)
    tip: str = Field(min_length=1)
    dialogue: list[RewrittenTurn]


class RewrittenTutorial(BaseModel):
    steps: list[RewrittenStep]


SYSTEM_PROMPT = (
    "Eres el redactor del tutorial de calcuol, el motor de simulaciones financieras "
    "de Pigui. Tu única tarea es RE-REDACTAR el contenido pedagógico adaptando el "
    "registro y los ejemplos al negocio real del usuario. Reglas inquebrantables:\n"
    "1. NO cambies ninguna afirmación sobre cómo funciona la plataforma: qué se "
    "edita y qué no, qué congela un snapshot, qué motores nacen apagados, qué "
    "verifica el servidor. Solo cambias ejemplos, analogías y tono.\n"
    "2. NO introduzcas números que no estén en el contenido original o en el "
    "contexto del proyecto. El LLM redacta; los números salen del motor.\n"
    "3. Conserva la estructura: mismos pasos (mismo key), y en cada diálogo el "
    "mismo número de turnos con los mismos hablantes en el mismo orden.\n"
    "4. Longitud similar al original: nada de párrafos inflados.\n"
    "5. Todo en español, con el tono cercano y concreto del tutorial (tú, "
    "ejemplos de a pie, cero jerga corporativa)."
)


def _steps_source(steps: list[dict]) -> list[dict]:
    """Solo los campos re-redactables, para el prompt y el fingerprint."""
    return [{
        "key": s["key"],
        "what": s["what"],
        "eli5": s["eli5"],
        "tip": s["tip"],
        "dialogue": s.get("dialogue", []),
    } for s in steps]


def fingerprint(project_id: str, ctx: dict, steps: list[dict], model: str) -> str:
    payload = json.dumps({"p": project_id, "c": ctx, "s": _steps_source(steps),
                          "m": model}, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(payload.encode()).hexdigest()


def build_prompt(ctx: dict, steps: list[dict]) -> str:
    return (
        "Contexto del proyecto del usuario (úsalo para adaptar ejemplos y registro):\n"
        f"{json.dumps(ctx, ensure_ascii=False, indent=1)}\n\n"
        "Contenido autorado a re-redactar (devuelve TODOS los pasos, con su key):\n"
        f"{json.dumps(_steps_source(steps), ensure_ascii=False, indent=1)}"
    )


def _numbers(text: str) -> set[str]:
    """Secuencias de dígitos normalizadas (sin separadores de miles)."""
    return {m.replace(",", "").replace(".", "")
            for m in re.findall(r"\d[\d.,]*", text)}


def _validate_step(source: dict, ctx: dict, step: RewrittenStep) -> dict | None:
    """Aplica el contrato a un paso; None si no lo cumple (se sirve el autorado)."""
    allowed = _numbers(json.dumps(source, ensure_ascii=False)) \
        | _numbers(json.dumps(ctx, ensure_ascii=False))

    fields = {"what": step.what, "eli5": step.eli5, "tip": step.tip}
    for name, text in fields.items():
        if not text.strip():
            return None
        if len(text) > LENGTH_RATIO_MAX * max(len(source[name]), 1):
            return None
        if not _numbers(text) <= allowed:
            return None

    src_dialogue = source.get("dialogue", [])
    if len(step.dialogue) != len(src_dialogue):
        return None
    dialogue = []
    for turn, src_turn in zip(step.dialogue, src_dialogue):
        if turn.speaker != src_turn["speaker"]:
            return None
        if len(turn.text) > LENGTH_RATIO_MAX * max(len(src_turn["text"]), 1):
            return None
        if not _numbers(turn.text) <= allowed:
            return None
        dialogue.append({"speaker": turn.speaker, "text": turn.text})

    return {"what": step.what, "eli5": step.eli5, "tip": step.tip,
            "dialogue": dialogue}


def get_cached(fp: str) -> dict | None:
    with _lock:
        return _cache.get(fp)


def status(fp: str) -> str:
    """'listo' | 'generando' | 'agotado' (falló MAX_ATTEMPTS veces)."""
    with _lock:
        if fp in _cache:
            return "listo"
        if _failures.get(fp, 0) >= MAX_ATTEMPTS:
            return "agotado"
        return "generando"


def should_generate(fp: str) -> bool:
    """Reserva el fingerprint para una generación (evita tareas duplicadas)."""
    with _lock:
        if fp in _cache or fp in _pending or _failures.get(fp, 0) >= MAX_ATTEMPTS:
            return False
        _pending.add(fp)
        return True


def generate(provider, fp: str, ctx: dict, steps: list[dict]) -> None:
    """Corre en background: llama al provider, valida por paso y guarda.

    Nunca propaga excepciones (un fallo del LLM jamás debe tumbar nada);
    los fallos se cuentan y tras MAX_ATTEMPTS se deja de intentar ese estado.
    """
    try:
        parsed = provider.rewrite(SYSTEM_PROMPT, build_prompt(ctx, steps),
                                  RewrittenTutorial)
        source_by_key = {s["key"]: s for s in _steps_source(steps)}
        valid: dict[str, dict] = {}
        if parsed is not None:
            for step in parsed.steps:
                source = source_by_key.get(step.key)
                if source is None:
                    continue
                rendered = _validate_step(source, ctx, step)
                if rendered is not None:
                    valid[step.key] = rendered
        with _lock:
            if valid:
                _cache[fp] = valid
                _failures.pop(fp, None)
            else:
                _failures[fp] = _failures.get(fp, 0) + 1
    except Exception:
        with _lock:
            _failures[fp] = _failures.get(fp, 0) + 1
    finally:
        with _lock:
            _pending.discard(fp)


def reset() -> None:
    """Limpia el estado en memoria (para tests)."""
    with _lock:
        _cache.clear()
        _pending.clear()
        _failures.clear()
