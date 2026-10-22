/* Транслитерация для поиска: «Милано Скам» → «Milano Скам», «Милано Skam», «Milano Skam» */
const MAP: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m",
  н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch",
  ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};

const hasCyrillic = (s: string) => /[а-яё]/i.test(s);

export function translit(word: string): string {
  return [...word]
    .map((ch) => {
      const low = ch.toLowerCase();
      const t = MAP[low];
      if (t === undefined) return ch;
      return ch === low ? t : t.charAt(0).toUpperCase() + t.slice(1);
    })
    .join("");
}

/** Варианты запроса: исходный, каждое кириллическое слово отдельно латиницей и всё латиницей (до 5 штук) */
export function queryVariants(q: string): string[] {
  if (!hasCyrillic(q)) return [q];
  const words = q.split(/\s+/).filter(Boolean);
  const variants = [q];
  if (words.length <= 3) {
    words.forEach((w, i) => {
      if (hasCyrillic(w)) variants.push(words.map((x, j) => (j === i ? translit(x) : x)).join(" "));
    });
  }
  variants.push(words.map(translit).join(" "));
  return [...new Set(variants)].slice(0, 5);
}
