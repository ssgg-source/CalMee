import { useState, useEffect, useRef } from 'react';
import { TranscriptSegmentData } from '@/types';

const TARGET_REVEAL_MS = 1050;
const INITIAL_CHARS = 1;

interface StreamingSegment {
  id: string;
  fullText: string;
  visibleText: string;
}

/**
 * Hook to manage the typewriter/streaming effect for new transcripts
 * Gradually reveals characters in a transcript over 800ms
 */
export function useTranscriptStreaming(
  segments: TranscriptSegmentData[],
  isRecording: boolean,
  enableStreaming: boolean
) {
  const [streamingSegment, setStreamingSegment] = useState<StreamingSegment | null>(null);
  const lastSegmentIdRef = useRef<string | null>(null);
  const lastFullTextRef = useRef('');
  const visibleLengthRef = useRef(0);
  const streamingIntervalRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (!isRecording || !enableStreaming || segments.length === 0) {
      // Clear streaming when not recording
      if (streamingIntervalRef.current) {
        clearInterval(streamingIntervalRef.current);
        streamingIntervalRef.current = null;
      }
      setStreamingSegment(null);
      lastSegmentIdRef.current = null;
      lastFullTextRef.current = '';
      visibleLengthRef.current = 0;
      return;
    }

    const latestSegment = segments[segments.length - 1];

    // A live Paraformer sentence grows inside the same merged segment. React
    // therefore keeps the same id while its text changes. Treat either a new
    // id or appended text as a streaming update; checking only the id left the
    // main recorder permanently showing its first phrase.
    if (latestSegment.id !== lastSegmentIdRef.current || latestSegment.text !== lastFullTextRef.current) {
      const isSameGrowingSegment = latestSegment.id === lastSegmentIdRef.current
        && latestSegment.text.startsWith(lastFullTextRef.current);
      lastSegmentIdRef.current = latestSegment.id;
      lastFullTextRef.current = latestSegment.text;

      // Clear any existing streaming interval
      if (streamingIntervalRef.current) {
        clearInterval(streamingIntervalRef.current);
        streamingIntervalRef.current = null;
      }

      const fullText = latestSegment.text;

      // Show first characters immediately
      const initialLength = isSameGrowingSegment
        ? Math.min(fullText.length, Math.max(INITIAL_CHARS, visibleLengthRef.current))
        : Math.min(INITIAL_CHARS, fullText.length);
      visibleLengthRef.current = initialLength;
      const initialText = fullText.substring(0, initialLength);

      setStreamingSegment({
        id: latestSegment.id,
        fullText,
        visibleText: initialText,
      });

      // If text is short enough, no need to stream
      if (fullText.length <= initialLength) {
        return;
      }

      // Release exactly one character at a time and spread the newly arrived
      // text across most of the 1.2 s ASR cadence. Short deltas previously
      // jumped two characters every 15 ms and looked just as blocky as no
      // animation at all.
      const remainingChars = fullText.length - initialLength;
      const intervalMs = Math.max(45, Math.min(260, Math.floor(TARGET_REVEAL_MS / remainingChars)));

      let charIndex = initialLength;

      streamingIntervalRef.current = setInterval(() => {
        charIndex += 1;

        if (charIndex >= fullText.length) {
          // Streaming complete - show full text
          setStreamingSegment({
            id: latestSegment.id,
            fullText,
            visibleText: fullText,
          });
          visibleLengthRef.current = fullText.length;

          // Clear interval
          if (streamingIntervalRef.current) {
            clearInterval(streamingIntervalRef.current);
            streamingIntervalRef.current = null;
          }
        } else {
          visibleLengthRef.current = charIndex;
          // Update visible text
          setStreamingSegment(prev => prev ? {
            ...prev,
            visibleText: fullText.substring(0, charIndex),
          } : null);
        }
      }, intervalMs);
    }

    // Cleanup on unmount or when dependencies change
    return () => {
      if (streamingIntervalRef.current) {
        clearInterval(streamingIntervalRef.current);
        streamingIntervalRef.current = null;
      }
    };
  }, [segments, isRecording, enableStreaming]);

  /**
   * Get the display text for a segment, with streaming effect if applicable
   */
  const getDisplayText = (segment: TranscriptSegmentData): string => {
    if (streamingSegment && segment.id === streamingSegment.id) {
      return streamingSegment.visibleText;
    }
    return segment.text;
  };

  return {
    streamingSegmentId: streamingSegment?.id ?? null,
    getDisplayText,
  };
}
