/** Voz opcional del diálogo del tutorial vía la Web Speech API (nativa, sin
 *  dependencias; funciona en el export estático). El texto en pantalla ES el
 *  contenido; la voz es mejora progresiva: sin soporte, el botón no aparece. */

export function ttsSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

function spanishVoice(): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis.getVoices();
  return voices.find((v) => v.lang.toLowerCase().startsWith("es-mx"))
    ?? voices.find((v) => v.lang.toLowerCase().startsWith("es"))
    ?? null;
}

/** Lee un texto y llama onEnd al terminar (también ante error, para que la
 *  cadena de turnos nunca se quede colgada). */
export function speak(text: string, onEnd: () => void): void {
  const utterance = new SpeechSynthesisUtterance(text);
  const voice = spanishVoice();
  if (voice) utterance.voice = voice;
  utterance.lang = voice?.lang ?? "es-MX";
  utterance.rate = 1.04;
  utterance.onend = onEnd;
  utterance.onerror = onEnd;
  window.speechSynthesis.speak(utterance);
}

export function stopSpeech(): void {
  if (ttsSupported()) window.speechSynthesis.cancel();
}
