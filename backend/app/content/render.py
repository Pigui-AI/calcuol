"""Re-redacción del tutorial con LLM — contrato estricto y fallback total.

El provider (app/content/llm_provider.py) re-escribe what/eli5/tip/diálogo de
cada paso adaptándolos al negocio real del usuario. Este módulo pone las
reglas deterministas alrededor:

- La salida usa el MISMO esquema que las plantillas y se valida con Pydantic.
- Guard de números: la redacción no puede introducir cifras que no existan en
  el contenido autorado (cualquier paso) o en el contexto del proyecto — el
  LLM redacta, no calcula. Se conserva el punto decimal al comparar ("1.2" no
  se confunde con "12") y se vigilan multiplicadores pegados a cifras
  ("5 mil", "$1.2M"). Los números escritos con letra ("quinientos") quedan
  fuera del guard: los cubre el system prompt, no esta red.
- Validación por paso: un paso inválido se descarta y ese paso sirve la
  versión autorada (fallback por slot, no por lote).
- Caché en memoria de UNA entrada por proyecto: un fingerprint nuevo
  (contexto, contenido o modelo distinto) reemplaza la entrada anterior, así
  la memoria queda acotada por proyectos vivos, no por historial de cambios.
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

MAX_ATTEMPTS = 3          # tras 3 fallos por estado se deja de intentar
LENGTH_RATIO_MAX = 2.5    # la redacción no puede inflar un campo más de 2.5x

_lock = threading.Lock()
_cache: dict[str, tuple[str, dict]] = {}     # project_id -> (fingerprint, pasos)
_failures: dict[str, tuple[str, int]] = {}   # project_id -> (fingerprint, intentos)
_pending: set[str] = set()                   # fingerprints generándose ahora


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
    "2. NO introduzcas números nuevos, ni en cifra ni escritos con letra: usa "
    "solo cantidades que ya estén en el contenido original o en el contexto del "
    "proyecto, sin cambiarles la escala. El LLM redacta; los números salen del motor.\n"
    "3. Conserva la estructura: mismos pasos (mismo key), y en cada diálogo el "
    "mismo número de turnos con los mismos hablantes en el mismo orden.\n"
    "4. Longitud similar al original: nada de párrafos inflados.\n"
    "5. Todo en español, con el tono cercano y concreto del tutorial (tú, "
    "ejemplos de a pie, cero jerga corporativa)."
)

# Multiplicadores que cambian la escala de una cifra ("5 mil", "$1.2M")
_SCALE_RE = re.compile(r"(\d[\d.,]*)\s*(mil(?:lones|lón)?|k|m|mdp)\b", re.IGNORECASE)


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


def _canonical(token: str) -> str:
    """Cifra canónica: quita separadores de millares y puntuación colgante,
    conservando el punto decimal ('92,000'→'92000'; '1.2'→'1.2'; '5.'→'5')."""
    token = re.sub(r"(?<=\d),(?=\d{3}\b)", "", token)
    return token.rstrip(".,")


def _numbers(text: str) -> set[str]:
    return {_canonical(m) for m in re.findall(r"\d[\d.,]*", text)}


def _scaled_numbers(text: str) -> set[tuple[str, str]]:
    """Pares (cifra, multiplicador) — '$1.2M' → ('1.2', 'm')."""
    return {(_canonical(num), scale.lower())
            for num, scale in _SCALE_RE.findall(text)}


def _source_texts(source: dict) -> list[str]:
    return [source["what"], source["eli5"], source["tip"]] + \
        [t["text"] for t in source.get("dialogue", [])]


def allowed_numbers(sources: list[dict], ctx: dict) -> tuple[set, set]:
    """Cifras y (cifra, escala) permitidas: SOLO los valores del contenido
    autorado (todos los pasos, alineado con el system prompt) y del contexto —
    nunca las claves del JSON (la clave 'eli5' no autoriza el dígito 5)."""
    texts = [str(v) for v in ctx.values()]
    for source in sources:
        texts += _source_texts(source)
    plain: set[str] = set()
    scaled: set[tuple[str, str]] = set()
    for text in texts:
        plain |= _numbers(text)
        scaled |= _scaled_numbers(text)
    return plain, scaled


def _validate_step(source: dict, allowed: set, allowed_scaled: set,
                   step: RewrittenStep) -> dict | None:
    """Aplica el contrato a un paso; None si no lo cumple (se sirve el autorado)."""
    def text_ok(text: str, original: str) -> bool:
        if not text.strip():
            return False
        if len(text) > LENGTH_RATIO_MAX * max(len(original), 1):
            return False
        if not _numbers(text) <= allowed:
            return False
        return _scaled_numbers(text) <= allowed_scaled

    if not (text_ok(step.what, source["what"]) and text_ok(step.eli5, source["eli5"])
            and text_ok(step.tip, source["tip"])):
        return None

    src_dialogue = source.get("dialogue", [])
    if len(step.dialogue) != len(src_dialogue):
        return None
    dialogue = []
    for turn, src_turn in zip(step.dialogue, src_dialogue):
        if turn.speaker != src_turn["speaker"]:
            return None
        if not text_ok(turn.text, src_turn["text"]):
            return None
        dialogue.append({"speaker": turn.speaker, "text": turn.text})

    return {"what": step.what, "eli5": step.eli5, "tip": step.tip,
            "dialogue": dialogue}


def _fail_count(project_id: str, fp: str) -> int:
    entry = _failures.get(project_id)
    return entry[1] if entry and entry[0] == fp else 0


def get_cached(project_id: str, fp: str) -> dict | None:
    with _lock:
        entry = _cache.get(project_id)
        return entry[1] if entry and entry[0] == fp else None


def status(project_id: str, fp: str) -> str:
    """'listo' | 'generando' | 'agotado' (falló MAX_ATTEMPTS veces)."""
    with _lock:
        entry = _cache.get(project_id)
        if entry and entry[0] == fp:
            return "listo"
        if _fail_count(project_id, fp) >= MAX_ATTEMPTS:
            return "agotado"
        return "generando"


def should_generate(project_id: str, fp: str) -> bool:
    """Reserva el fingerprint para una generación (evita tareas duplicadas)."""
    with _lock:
        entry = _cache.get(project_id)
        if entry and entry[0] == fp:
            return False
        if fp in _pending or _fail_count(project_id, fp) >= MAX_ATTEMPTS:
            return False
        _pending.add(fp)
        return True


def generate(provider, project_id: str, fp: str, ctx: dict, steps: list[dict]) -> None:
    """Corre en background: llama al provider, valida por paso y guarda.

    Nunca propaga excepciones (un fallo del LLM jamás debe tumbar nada); los
    fallos se cuentan por proyecto y tras MAX_ATTEMPTS se deja de intentar ese
    estado. Guardar reemplaza la entrada anterior del proyecto: la caché queda
    acotada a una entrada por proyecto vivo.
    """
    try:
        parsed = provider.rewrite(SYSTEM_PROMPT, build_prompt(ctx, steps),
                                  RewrittenTutorial)
        sources = _steps_source(steps)
        source_by_key = {s["key"]: s for s in sources}
        allowed, allowed_scaled = allowed_numbers(sources, ctx)
        valid: dict[str, dict] = {}
        if parsed is not None:
            for step in parsed.steps:
                source = source_by_key.get(step.key)
                if source is None:
                    continue
                rendered = _validate_step(source, allowed, allowed_scaled, step)
                if rendered is not None:
                    valid[step.key] = rendered
        with _lock:
            if valid:
                _cache[project_id] = (fp, valid)
                _failures.pop(project_id, None)
            else:
                _failures[project_id] = (fp, _fail_count(project_id, fp) + 1)
    except Exception:
        with _lock:
            _failures[project_id] = (fp, _fail_count(project_id, fp) + 1)
    finally:
        with _lock:
            _pending.discard(fp)


def reset() -> None:
    """Limpia el estado en memoria (para tests)."""
    with _lock:
        _cache.clear()
        _pending.clear()
        _failures.clear()
