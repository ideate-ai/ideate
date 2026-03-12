# Work Item 049: Fix Remote Worker Lifespan Coroutine Shutdown

## Objective

Fix the `lifespan` context manager in `mcp/remote-worker/server.py` to store worker task references and cancel them on application shutdown. Currently task references are discarded and workers are abandoned on shutdown rather than being cleanly terminated.

## Acceptance Criteria

1. Worker coroutine task references are stored in a local list during the startup phase of the lifespan context manager
2. On shutdown (after `yield`), all worker tasks are cancelled
3. After cancellation, the lifespan awaits `asyncio.gather(*tasks, return_exceptions=True)` to allow clean task termination
4. A shutdown log message is emitted confirming workers were cancelled
5. Existing 32 tests continue to pass
6. The lifespan function signature and `asyncio.create_task` call pattern are otherwise unchanged

## File Scope

- modify: `mcp/remote-worker/server.py`

## Dependencies

None.

## Implementation Notes

Current code (approximately lines 83-90):
```python
@asynccontextmanager
async def lifespan(application: FastAPI):
    global _max_concurrency
    _max_concurrency = _get_max_concurrency()
    for i in range(_max_concurrency):
        asyncio.create_task(_worker(i))
    logger.info("Started %d worker coroutines", _max_concurrency)
    yield
```

Updated code:
```python
@asynccontextmanager
async def lifespan(application: FastAPI):
    global _max_concurrency
    _max_concurrency = _get_max_concurrency()
    tasks = [asyncio.create_task(_worker(i)) for i in range(_max_concurrency)]
    logger.info("Started %d worker coroutines", _max_concurrency)
    yield
    for t in tasks:
        t.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    logger.info("Worker coroutines cancelled")
```

The `return_exceptions=True` is required to prevent `CancelledError` from propagating as an unhandled exception during gather.

## Complexity

Low
