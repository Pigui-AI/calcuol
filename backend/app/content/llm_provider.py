"""Provider LLM opcional del tutorial — espejo del hook `provider` de imports.

Regla de oro: el LLM REDACTA, no calcula ni inventa. Re-escribe el contenido
autorado adaptando registro y ejemplos al negocio real del usuario; toda
afirmación sobre el funcionamiento del motor debe conservarse. La salida se
valida contra el mismo esquema que las plantillas (app/content/render.py) y
ante cualquier fallo se sirve la versión determinista.

Activación: requiere credenciales de Anthropic en el entorno
(ANTHROPIC_API_KEY o ANTHROPIC_AUTH_TOKEN, p. ej. como secreto en Cloud Run).
TUTORIAL_LLM=off lo apaga aunque haya credenciales; TUTORIAL_LLM=on fuerza el
intento (útil con perfiles locales de `ant auth login`).
"""
import os

DEFAULT_MODEL = "claude-opus-5"


class AnthropicProvider:
    """Redacta el tutorial con la API de Claude usando structured outputs:
    la respuesta llega ya parseada y validada contra el esquema Pydantic."""

    def __init__(self):
        import anthropic  # import tardío: la dependencia es opcional en runtime

        self._client = anthropic.Anthropic()
        self.model = os.environ.get("TUTORIAL_LLM_MODEL", DEFAULT_MODEL)
        # tarea de redacción mecánica: esfuerzo bajo por defecto para no
        # gastar de más; subible vía entorno si se quiere más pluma
        self.effort = os.environ.get("TUTORIAL_LLM_EFFORT", "low")

    def rewrite(self, system: str, prompt: str, schema):
        """Devuelve una instancia validada de `schema` o None.

        None ante cualquier final que no sea end_turn: refusal de los
        clasificadores, truncado por max_tokens (con thinking activo el tope
        cubre razonamiento + respuesta), etc. El que llama cuenta el fallo.
        """
        response = self._client.messages.parse(
            model=self.model,
            max_tokens=16000,
            system=system,
            output_config={"effort": self.effort},
            messages=[{"role": "user", "content": prompt}],
            output_format=schema,
        )
        if response.stop_reason != "end_turn":
            return None
        return response.parsed_output


def _env_signature() -> tuple:
    return (
        os.environ.get("TUTORIAL_LLM", "auto").lower(),
        bool(os.environ.get("ANTHROPIC_API_KEY")),
        bool(os.environ.get("ANTHROPIC_AUTH_TOKEN")),
        os.environ.get("TUTORIAL_LLM_MODEL", DEFAULT_MODEL),
        os.environ.get("TUTORIAL_LLM_EFFORT", "low"),
    )


# El cliente de Anthropic construye un httpx.Client (SSLContext + certifi) al
# instanciarse: se memoiza por firma del entorno para no pagar ese costo en
# cada GET /onboarding.
_memo: dict = {"sig": None, "provider": None}


def default_provider() -> AnthropicProvider | None:
    """Provider memoizado; None si está deshabilitado o el SDK no está."""
    sig = _env_signature()
    if _memo["sig"] == sig:
        return _memo["provider"]

    provider = None
    mode = sig[0]
    enabled = mode == "on" or (mode != "off" and (sig[1] or sig[2]))
    if enabled:
        try:
            provider = AnthropicProvider()
        except Exception:
            provider = None
    _memo["sig"] = sig
    _memo["provider"] = provider
    return provider
