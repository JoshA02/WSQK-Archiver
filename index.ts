import { createWriteStream } from 'node:fs';
import { mkdirSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream";
import { promisify } from "node:util";
import { readFile, utimes } from "node:fs/promises";
import fs from 'node:fs';

const streamPipeline = promisify(pipeline);

const BASE_API_URL = "https://www.globalplayer.com/_next/data/ioXFOWz_-eelUOJbwURpg/catchup/wsqk";
const WSQK_URL = `${BASE_API_URL}/uk.json?brand=wsqk&station=uk`;
const BASE_CATCHUP_URL = `${BASE_API_URL}/uk/CATCHUP_ID.json?brand=wsqk&station=uk&id=CATCHUP_ID`;

type DateKey = string; // e.g. "2025-01-01"
type TimeKey = string; // e.g. "10-00-00"
type ScheduleForDate = Record<TimeKey, string>;
type Schedule = Record<DateKey, ScheduleForDate>;

interface ScheduleEntry {
  date: DateKey;
  time: TimeKey;
  path: string;
}
type ScheduleEntries = ScheduleEntry[];
let schedule: ScheduleEntries = [];


async function main() {
  await loadScheduleEntriesFromFile();
  console.log(`Loaded existing schedule with ${schedule.length} entries.`);

  const base_res = await fetch(WSQK_URL, {
  "headers": {
    "Referer": "https://www.globalplayer.com/catchup/wsqk/uk/"
  },
  "body": null,
  "method": "GET"
  }).then(res => res.json());

  const catchupInfo = base_res.pageProps.catchupInfo;
  console.log(`Found ${catchupInfo.length} WSQK catchup items:`);

  for (const item of catchupInfo) {
    await processCatchupItem(item);
  }

  // write schedule to 'schedule.json'
  const jsonSchedule = buildScheduleObject(schedule);
  fs.writeFileSync('./downloads/schedule.json', JSON.stringify(jsonSchedule, null, 2));

  console.log(`\nSchedule written to ./downloads/schedule.json`);
}
main();

async function loadScheduleEntriesFromFile() {
  try {
    const raw = await readFile("./downloads/schedule.json", "utf8");
    const obj = JSON.parse(raw) as Schedule;

    for (const [date, times] of Object.entries(obj)) {
      for (const [time, path] of Object.entries(times)) {
        addScheduleEntry({ date, time, path });
      }
    }
  } catch (err: any) {
    if (err.code !== "ENOENT") {
      throw err; // Real error; rethrow
    }
  }
}

function addScheduleEntry(entry: ScheduleEntry): void {
  schedule.push(entry);
  schedule.sort((a, b) => {
    if (a.date < b.date) return -1;
    if (a.date > b.date) return 1;
    if (a.time < b.time) return -1;
    if (a.time > b.time) return 1;
    return 0;
  });
}

function buildScheduleObject(entries: ScheduleEntries): Schedule {
  const schedule: Schedule = {};

  for (const { date, time, path } of entries) {
    if (!schedule[date]) {
      schedule[date] = {};
    }
    schedule[date][time] = path;
  }

  return schedule;
}

async function processCatchupItem(item: {
  id: string;
  title: string;
  description: string;
  imageUrl: string;
}) {
  process.stdout.write(`- ${item.title}: `);

  const catchup_res = await fetch(`${BASE_CATCHUP_URL.replace('CATCHUP_ID', item.id)}`, {
    "headers": {
      "Referer": "https://www.globalplayer.com/catchup/wsqk/uk/"
    },
    "body": null,
    "method": "GET"
  }).then(res => res.json());

  const showTitle = catchup_res.pageProps.catchupInfo.title;
  const showDescription = catchup_res.pageProps.catchupInfo.description;

  // Create a safe folder name from the show title
  let safeTitle = showTitle.split('|').pop() || showTitle;
  safeTitle = safeTitle.trim().replace(/[^a-z0-9]/gi, "_").toLowerCase();

  // Ensure folder exists
  mkdirSync(`./downloads/${safeTitle}`, { recursive: true });
  
  // Write show info to a JSON file
  const infoFilePath = `./downloads/${safeTitle}/show_info.json`;
  if(!fs.existsSync(infoFilePath)) {
    const info = {
      "show_title": showTitle,
      "show_description": showDescription
    };
    const infoContent = JSON.stringify(info, null, 2);
    fs.writeFileSync(infoFilePath, infoContent);
  }

  const episodes = catchup_res.pageProps.catchupInfo.episodes;
  console.log(`found ${episodes.length} episodes`);
  for (const episode of episodes) {
    await downloadEpisode(episode, safeTitle);
  }
}

async function downloadEpisode(episode: {
  startDate: string;
  streamUrl: string;
}, safeTitle: string
) {
  const startDate = new Date(episode.startDate);
  const streamURL = episode.streamUrl;
  const safeDate = startDate.toISOString().split('T')[0] + '_' + startDate.toTimeString().split(' ')[0].replace(/:/g, '-');
  const localDownloadPath = `${safeTitle}/${safeDate}.m4a`;
  const scheduleEntry: ScheduleEntry = {
    date: startDate.toISOString().split('T')[0],
    time: startDate.toTimeString().split(' ')[0].replace(/:/g, '-'),
    path: localDownloadPath
  };

  process.stdout.write(`\t- aired @ ${startDate.toLocaleString()}: `);
  
  if (!streamURL) {
    console.log('FAILED - no stream URL found');
    return;
  }
  
  const res = await fetch(streamURL, {
    "headers": {
      "Referer": "https://www.globalplayer.com/catchup/wsqk/uk/"
    },
    "body": null,
    "method": "GET"
  });

  if (!res.ok || !res.body) {
    console.log(`FAILED - fetch error: ${res.status} ${res.statusText}`);
    return;
  }

  process.stdout.write(`\tdownloading...  `);

  // Ensure folder exists
  mkdirSync(`./downloads/${safeTitle}`, { recursive: true });

  const outputPath = `./downloads/${localDownloadPath}`;

  // Check if file already exists
  if(fs.existsSync(outputPath)) {
    console.log(`\t  skipped (already exists)`);

    // Update schedule object
    addScheduleEntry(scheduleEntry);

    return;
  }

  // Convert Web ReadableStream → Node Readable
  const nodeStream = Readable.fromWeb(res.body as any);

  // Pipe to file and await completion
  await streamPipeline(nodeStream, createWriteStream(outputPath));
  
  // Update file timestamps to match broadcast time
  await utimes(outputPath, startDate, startDate);

  // Update schedule object
  addScheduleEntry(scheduleEntry);

  console.log(`\t  done!`);
}