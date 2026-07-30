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
        """Devuelve una instancia validada de `schema` o None (refusal/parseo)."""
        response = self._client.messages.parse(
            model=self.model,
            max_tokens=16000,
            system=system,
            output_config={"effort": self.effort},
            messages=[{"role": "user", "content": prompt}],
            output_format=schema,
        )
        if response.stop_reason == "refusal":
            return None
        return response.parsed_output


def default_provider() -> AnthropicProvider | None:
    """Instancia el provider solo si está habilitado y el SDK está disponible."""
    mode = os.environ.get("TUTORIAL_LLM", "auto").lower()
    if mode == "off":
        return None
    if mode != "on" and not (os.environ.get("ANTHROPIC_API_KEY")
                             or os.environ.get("ANTHROPIC_AUTH_TOKEN")):
        return None
    try:
        return AnthropicProvider()
    except Exception:
        return None
