export default function health(_request, response) {
  response.status(200).json({ ok: true, service: 'air-plain-game' });
}
