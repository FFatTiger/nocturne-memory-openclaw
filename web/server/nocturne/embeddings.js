function vectorLiteral(value) {
  if (Array.isArray(value)) return `[${value.map((item) => Number(item)).join(',')}]`;
  return String(value || '[]');
}

async function embedTexts(embedding, inputs) {
  const results = [];
  for (const text of inputs) {
    const response = await fetch(`${String(embedding.base_url || '').replace(/\/$/, '')}/embeddings`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${embedding.api_key}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: embedding.model, input: text }),
    });
    if (!response.ok) {
      throw new Error(`Embedding request failed: ${response.status}`);
    }
    const data = await response.json();
    const rows = [...(data.data || [])].sort((a, b) => (a.index || 0) - (b.index || 0));
    if (!rows[0]?.embedding) throw new Error('Embedding response missing data rows');
    results.push(rows[0].embedding);
  }
  return results;
}

export { embedTexts, vectorLiteral };
