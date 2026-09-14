import { useEffect, useRef, useState } from "react";

interface UseIntersectionObserverOptions {
	threshold?: number;
	rootMargin?: string;
	triggerOnce?: boolean;
}

export function useIntersectionObserver(options: UseIntersectionObserverOptions = {}) {
	const { threshold = 0, rootMargin = "0px", triggerOnce = false } = options;
	const [isIntersecting, setIsIntersecting] = useState(false);
	const [hasTriggered, setHasTriggered] = useState(false);
	const targetRef = useRef<HTMLElement | null>(null);

	useEffect(() => {
		const element = targetRef.current;
		if (!element) return;

		if (triggerOnce && hasTriggered) return;

		const observer = new IntersectionObserver(
			([entry]) => {
				const isVisible = entry?.isIntersecting ?? false;
				setIsIntersecting(isVisible);

				if (isVisible && triggerOnce) {
					setHasTriggered(true);
					observer.disconnect();
				}
			},
			{ threshold, rootMargin },
		);

		observer.observe(element);

		return () => {
			observer.disconnect();
		};
	}, [threshold, rootMargin, triggerOnce, hasTriggered]);

	return { ref: targetRef, isIntersecting, hasTriggered };
}

export function useDeferredRender(delay: number = 100) {
	const [shouldRender, setShouldRender] = useState(false);

	useEffect(() => {
		const timer = setTimeout(() => {
			setShouldRender(true);
		}, delay);

		return () => clearTimeout(timer);
	}, [delay]);

	return shouldRender;
}
