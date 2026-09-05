import { useCallback, useEffect, useRef, useState } from 'react';

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

export function usePanZoom() {
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, zoom: 1 });
  const isPanning = useRef(false);
  const isSpacePressed = useRef(false);
  const lastPointer = useRef({ x: 0, y: 0 });
  const containerRef = useRef<HTMLElement | null>(null);

  // Native wheel handler — bypasses React's passive listener default
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      // Check if wheel target is inside a scrollable element
      let target = e.target as HTMLElement | null;
      while (target && target !== el) {
        const style = getComputedStyle(target);
        const overflowY = style.overflowY;
        const _overflowX = style.overflowX;
        const isScrollable =
          (overflowY === 'auto' || overflowY === 'scroll') &&
          target.scrollHeight > target.clientHeight;
        if (isScrollable) {
          // Let the scrollable element handle the wheel event
          return;
        }
        target = target.parentElement;
      }

      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const zoomFactor = e.deltaY > 0 ? -0.1 : 0.1;
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      setViewport((prev) => {
        const newZoom = Math.max(0.1, Math.min(5, prev.zoom + zoomFactor));
        const scale = newZoom / prev.zoom;
        return {
          x: mouseX - scale * (mouseX - prev.x),
          y: mouseY - scale * (mouseY - prev.y),
          zoom: newZoom,
        };
      });
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        isSpacePressed.current = true;
        // Prevent default spacebar scrolling
        if (e.target === document.body) {
          e.preventDefault();
        }
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        isSpacePressed.current = false;
        isPanning.current = false; // Stop panning if space is released
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

  // Ref callback for the viewport element
  const setContainerRef = useCallback((node: HTMLElement | null) => {
    containerRef.current = node;
  }, []);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (
      e.button === 1 ||
      (e.button === 0 && e.target === e.currentTarget) ||
      (e.button === 0 && isSpacePressed.current)
    ) {
      isPanning.current = true;
      lastPointer.current = { x: e.clientX, y: e.clientY };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }
  }, []);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!isPanning.current) return;
    const dx = e.clientX - lastPointer.current.x;
    const dy = e.clientY - lastPointer.current.y;
    lastPointer.current = { x: e.clientX, y: e.clientY };
    setViewport((prev) => ({
      ...prev,
      x: prev.x + dx,
      y: prev.y + dy,
    }));
  }, []);

  const handlePointerUp = useCallback(() => {
    isPanning.current = false;
  }, []);

  const transform = `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`;

  const zoomIn = useCallback(
    () => setViewport((p) => ({ ...p, zoom: Math.min(5, +(p.zoom + 0.1).toFixed(1)) })),
    [],
  );
  const zoomOut = useCallback(
    () => setViewport((p) => ({ ...p, zoom: Math.max(0.1, +(p.zoom - 0.1).toFixed(1)) })),
    [],
  );
  const resetZoom = useCallback(() => setViewport((p) => ({ ...p, zoom: 1, x: 0, y: 0 })), []);

  return {
    viewport,
    setViewport,
    transform,
    setContainerRef,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    zoomIn,
    zoomOut,
    resetZoom,
  };
}
