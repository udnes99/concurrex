export type Callback<T> = {
    promise: Promise<T>;
    resolve: (result: T) => void;
    reject: (reason?: unknown) => void;
};

export function createCallback<T>(): Callback<T> {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;

    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });

    return { promise, resolve, reject };
}
