import { z } from 'zod';
import { AppError } from '../shared/types.js';

export const weatherLocation = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[\p{L}\p{M}\p{N} .,'’()+-]+$/u)
  .refine((value) => /[\p{L}\p{N}]/u.test(value));

const valueList = z.array(z.object({ value: z.string().max(200) })).min(1);
const weatherData = z.object({
  nearest_area: z
    .array(z.object({ areaName: valueList, region: valueList, country: valueList }))
    .min(1),
  current_condition: z
    .array(
      z.object({
        temp_C: z.string(),
        FeelsLikeC: z.string(),
        humidity: z.string(),
        windspeedKmph: z.string(),
        observation_time: z.string(),
        weatherDesc: valueList,
      }),
    )
    .min(1),
  weather: z
    .array(z.object({ date: z.string(), mintempC: z.string(), maxtempC: z.string() }))
    .min(1),
});

export async function lookupWeather(location: string, signal: AbortSignal) {
  const query = weatherLocation.parse(location);
  const url = new URL(`https://wttr.in/${encodeURIComponent(query)}?format=j1`);
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
  try {
    const response = await fetch(url, { signal: requestSignal, redirect: 'error' });
    if (!response.ok || !response.body) throw new Error('Invalid weather response');
    const reader = response.body.getReader();
    let bytes = 0;
    const decoder = new TextDecoder();
    let text = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 256 * 1024) {
        await reader.cancel();
        throw new Error('Weather response too large');
      }
      text += decoder.decode(value, { stream: true });
    }
    const data = weatherData.parse(JSON.parse(text + decoder.decode()));
    const area = data.nearest_area[0]!;
    const current = data.current_condition[0]!;
    return {
      source: 'wttr.in',
      requestedLocation: query,
      matchedLocation: [area.areaName[0]!.value, area.region[0]!.value, area.country[0]!.value],
      current: {
        temperatureC: current.temp_C,
        feelsLikeC: current.FeelsLikeC,
        humidityPercent: current.humidity,
        windKph: current.windspeedKmph,
        observationTimeUtc: current.observation_time,
        condition: current.weatherDesc[0]!.value,
      },
      forecast: data.weather.slice(0, 3).map((day) => ({
        date: day.date,
        minC: day.mintempC,
        maxC: day.maxtempC,
      })),
    };
  } catch {
    signal.throwIfAborted();
    throw new AppError('WEATHER_UNAVAILABLE', '天气服务暂未返回有效结果，请确认地点后重试。', 502);
  }
}
