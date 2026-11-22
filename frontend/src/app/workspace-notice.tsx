/**
 * @file 显示并播报工作区操作反馈。
 * @implementation 固定实时播报节点，单独过渡可见反馈，并遵从减少动态效果设置。
 * @updated 2026-11-23T04:49:37+08:00
 */
import { AnimatePresence, useReducedMotion, type Transition } from 'motion/react';
import * as m from 'motion/react-m';

export const feedbackTransition = {
  duration: 0.16,
  ease: [0.23, 1, 0.32, 1],
} satisfies Transition;

export function WorkspaceNotice({ message }: { message: string }) {
  const reduceMotion = useReducedMotion();

  return (
    <>
      <span className="sr-only" role="status">
        {message}
      </span>
      <AnimatePresence initial={false}>
        {message ? (
          <m.div
            key="notice"
            className="workspace-notice"
            aria-hidden="true"
            initial={reduceMotion ? false : { opacity: 0.6, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={reduceMotion ? { duration: 0 } : feedbackTransition}
          >
            {message}
          </m.div>
        ) : null}
      </AnimatePresence>
    </>
  );
}
