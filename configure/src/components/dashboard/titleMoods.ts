const TONE: Record<string, string[]> = {
  suspenseful: ["Suspenseful"],
  suspense: ["Suspenseful"],
  tense: ["Suspenseful"],
  dark: ["Dark"],
  grimdark: ["Dark"],
  "dark fantasy": ["Dark"],
  "dark comedy": ["Dark", "Witty"],
  hilarious: ["Funny"],
  amused: ["Funny"],
  playful: ["Playful"],
  absurd: ["Offbeat"],
  absurdism: ["Offbeat"],
  irreverent: ["Irreverent"],
  comforting: ["Feel-good"],
  hopeful: ["Inspiring"],
  inspirational: ["Inspiring"],
  admiring: ["Inspiring"],
  awestruck: ["Awe-inspiring"],
  intense: ["Intense"],
  bold: ["Intense"],
  dramatic: ["Emotional"],
  melodramatic: ["Emotional"],
  nostalgic: ["Nostalgic"],
  epic: ["Epic"],
  "epic fantasy": ["Epic"],
  tragicomedy: ["Bittersweet"],
  sadness: ["Heartbreaking"],
  allegory: ["Cerebral"],
};

const TOPIC: Record<string, string[]> = {
  "psychological thriller": ["Suspenseful", "Cerebral"],
  "mind-bending": ["Cerebral"],
  "time travel": ["Cerebral"],
  philosophy: ["Cerebral"],
  heist: ["Exciting"],
  superhero: ["Exciting"],
  revenge: ["Intense"],
  survival: ["Intense"],
  friendship: ["Heartfelt"],
  "coming of age": ["Heartfelt"],
  satire: ["Irreverent"],
  parody: ["Irreverent"],
  sitcom: ["Funny"],
  supernatural: ["Eerie"],
  ghost: ["Eerie"],
  "haunted house": ["Eerie"],
  dystopia: ["Dark"],
  "serial killer": ["Dark"],
  conspiracy: ["Suspenseful"],
  romance: ["Romantic"],
  war: ["Gritty"],
};

const GENRE: Record<string, string[]> = {
  horror: ["Scary"],
  thriller: ["Suspenseful"],
  suspense: ["Suspenseful"],
  mystery: ["Suspenseful"],
  comedy: ["Funny"],
  romance: ["Romantic"],
  action: ["Exciting"],
  adventure: ["Exciting"],
  "action & adventure": ["Exciting"],
  war: ["Gritty"],
  "war & politics": ["Gritty"],
  crime: ["Gritty"],
  western: ["Gritty"],
  family: ["Feel-good"],
  kids: ["Feel-good"],
  drama: ["Emotional"],
  "science fiction": ["Imaginative"],
  "sci-fi": ["Imaginative"],
  "sci-fi & fantasy": ["Imaginative"],
  fantasy: ["Imaginative"],
  documentary: ["Insightful"],
};

export function moodsFor(tags: string[], genres: string[], max = 3): string[] {
  const out: string[] = [];
  const add = (moods: string[] | undefined) => {
    for (const mood of moods ?? []) if (!out.includes(mood)) out.push(mood);
  };
  const lowered = tags.map((tag) => tag.toLowerCase());
  for (const tag of lowered) add(TONE[tag]);
  for (const tag of lowered) add(TOPIC[tag]);
  for (const genre of genres) add(GENRE[genre.toLowerCase()]);
  return out.slice(0, max);
}
